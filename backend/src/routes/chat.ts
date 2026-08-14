import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { Tool } from '@aws-sdk/client-bedrock-runtime';
import { requireAuth } from '../middleware/requireAuth';
import { generateReplyWithTools, type ToolHandler } from '../services/bedrock';
import { getLoyaltyPoints, redeemCoupon, trackLoyaltyPoints } from '../services/loyalty';
import { initiateCiba, pollCibaUntilDone } from '../services/ciba';
import {
  getOrCreateConversation,
  appendMessage,
  listConversations,
} from '../services/dynamodb-sessions';

const router = Router();

// List conversations for the authenticated user
router.get('/conversations', requireAuth, async (req, res) => {
  try {
    const conversations = await listConversations(req.oidc!.user!.sub);
    res.json(conversations);
  } catch (err) {
    console.error('List conversations error:', err);
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

// Bedrock tool definitions — injected into every chat request
function buildTools(loyaltyId?: string | number): Tool[] {
  if (!loyaltyId) return [];
  return [
    {
      toolSpec: {
        name: 'get_loyalty_points',
        description: 'Get the current loyalty points balance for the authenticated user. Call this when the user asks about their points, balance, or loyalty rewards.',
        inputSchema: { json: { type: 'object', properties: {}, required: [] } },
      },
    },
    {
      toolSpec: {
        name: 'redeem_coupon',
        description: 'Redeem a coupon code against the loyalty program. Returns whether it was successful and the updated points balance. Call this when the user wants to use, apply, or redeem a coupon or promo code.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              couponCode: {
                type: 'string',
                description: 'The coupon or promotional code to redeem (e.g. SAVE20, SUMMER10)',
              },
            },
            required: ['couponCode'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'purchase_with_points',
        description: 'Purchase a store item using loyalty points. Sends a Guardian push notification to the user\'s phone for approval and waits for them to approve (up to 90 seconds). Call this when the user says they want to buy, purchase, or spend points on an item. $1.00 items cost 100 points; $1.25 items cost 125 points.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              itemName: {
                type: 'string',
                description: 'The exact name of the item being purchased (e.g. "Chocolate Mix Bag")',
              },
              pointsCost: {
                type: 'number',
                description: 'Points to deduct. $1.00 = 100 points, $1.25 = 125 points.',
              },
            },
            required: ['itemName', 'pointsCost'],
          },
        },
      },
    },
  ];
}

// Send a message and receive an AI reply
router.post('/chat', requireAuth, async (req, res) => {
  const { message, conversationId: existingId } = req.body as {
    message?: string;
    conversationId?: string;
  };

  if (!message || typeof message !== 'string' || message.trim() === '') {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const oidcUser = req.oidc!.user!;
  const userId = oidcUser.sub;
  const loyaltyId = oidcUser.loyaltyId as string | number | undefined;

  try {
    const conversationId = existingId ?? uuidv4();
    const conversation = await getOrCreateConversation(conversationId, userId);

    if (conversation.userId !== userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const userMessage = {
      id: uuidv4(),
      role: 'user' as const,
      content: message.trim(),
      timestamp: new Date().toISOString(),
    };

    await appendMessage(conversationId, userMessage);
    const updatedMessages = [...conversation.messages, userMessage];

    // Captures auth_req_id when purchase_with_points initiates CIBA
    let pendingCiba: { auth_req_id: string; itemName: string; pointsCost: number; interval: number } | null = null;

    // Build tool handler closure over loyaltyId
    const toolHandler: ToolHandler = async (toolName, _input) => {
      console.log('[chat] tool called:', toolName, JSON.stringify(_input));
      if (!loyaltyId) return JSON.stringify({ error: 'No loyalty account linked' });

      if (toolName === 'get_loyalty_points') {
        const data = await getLoyaltyPoints(loyaltyId);
        return JSON.stringify({
          totalPoints: data.totalPoints,
          loyaltyId: data.loyaltyId,
          message: `You have ${data.totalPoints.toLocaleString()} loyalty points.`,
        });
      }

      if (toolName === 'redeem_coupon') {
        const code = ((_input as { couponCode?: string }).couponCode ?? '').trim().toUpperCase();
        if (!code) return JSON.stringify({ success: false, message: 'No coupon code provided.' });
        const result = await redeemCoupon(loyaltyId, code);
        return JSON.stringify(result);
      }

      if (toolName === 'purchase_with_points') {
        const input = _input as { itemName?: string; pointsCost?: number };
        const itemName = (input.itemName ?? '').trim();
        const pointsCost = Number(input.pointsCost ?? 0);

        if (!itemName || pointsCost <= 0) {
          return JSON.stringify({ success: false, message: 'Item name and point cost are required.' });
        }

        // Pre-flight balance check to avoid a pointless Guardian push
        const balanceData = await getLoyaltyPoints(loyaltyId);
        if (balanceData.totalPoints < pointsCost) {
          return JSON.stringify({
            success: false,
            message: `Insufficient points. You have ${balanceData.totalPoints} points but ${itemName} costs ${pointsCost} points.`,
          });
        }

        const bindingMessage = `Buy ${itemName} for ${pointsCost} pts`;

        try {
          const cibaResult = await initiateCiba(userId, bindingMessage);
          // Return immediately — the frontend polls /api/purchase/poll for the result
          pendingCiba = { auth_req_id: cibaResult.authReqId, itemName, pointsCost, interval: cibaResult.interval };
          return JSON.stringify({
            status: 'ciba_pending',
            message: `Guardian push sent for ${itemName} (${pointsCost} pts). Please approve on your phone.`,
          });
        } catch (err) {
          console.error('[chat] CIBA initiate error:', err);
          return JSON.stringify({ success: false, message: 'Could not send approval request. Please try again.' });
        }
      }

      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    };

    const tools = buildTools(loyaltyId);
    const systemPrompt = loyaltyId
      ? 'You are DT (Dollar Treasure) AI Assistant. When the user wants to redeem a coupon or promo code, you MUST call the redeem_coupon tool. When the user asks about their points or balance, you MUST call get_loyalty_points. When the user wants to buy or purchase a store item using their points, you MUST call purchase_with_points with the item name and cost ($1.00 items = 100 points, $1.25 items = 125 points). When purchase_with_points returns status=ciba_pending, tell the user a Guardian push notification has been sent to their phone and they should approve it there to complete the purchase. Do not say you are waiting — the approval UI is shown separately. Always use these tools for loyalty operations.'
      : undefined;
    const replyText = await generateReplyWithTools(updatedMessages, tools, toolHandler, systemPrompt);

    const assistantMessage = {
      id: uuidv4(),
      role: 'assistant' as const,
      content: replyText,
      timestamp: new Date().toISOString(),
    };

    await appendMessage(conversationId, assistantMessage);
    res.json({
      conversationId,
      message: assistantMessage,
      ...(pendingCiba ? { cibaState: pendingCiba } : {}),
    });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Failed to generate response' });
  }
});

export default router;
