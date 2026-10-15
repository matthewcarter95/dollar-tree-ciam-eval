import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message as BedrockMessage,
  type Tool,
  type ToolResultBlock,
  type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { Message } from '../types';

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'amazon.nova-micro-v1:0';

// Plain text generation — no tools
export async function generateReply(history: Message[]): Promise<string> {
  const bedrockMessages: BedrockMessage[] = history.map((m) => ({
    role: m.role,
    content: [{ text: m.content }],
  }));

  const response = await client.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      messages: bedrockMessages,
      inferenceConfig: { maxTokens: 1024, temperature: 0.7 },
    })
  );

  const output = response.output?.message?.content?.[0];
  if (!output || output.text === undefined) throw new Error('Unexpected Bedrock response shape');
  return output.text;
}

export type ToolHandler = (toolName: string, toolInput: Record<string, unknown>) => Promise<string>;

// Generation with tool-use loop — Bedrock calls tools until end_turn
export async function generateReplyWithTools(
  history: Message[],
  tools: Tool[],
  toolHandler: ToolHandler,
  systemPrompt?: string
): Promise<string> {
  const bedrockMessages: BedrockMessage[] = history.map((m) => ({
    role: m.role,
    content: [{ text: m.content }],
  }));

  const maxIterations = 8;
  for (let i = 0; i < maxIterations; i++) {
    const response = await client.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        messages: bedrockMessages,
        // Bedrock rejects an empty tools array, so omit toolConfig when there are none.
        ...(tools.length ? { toolConfig: { tools } } : {}),
        ...(systemPrompt ? { system: [{ text: systemPrompt }] } : {}),
        inferenceConfig: { maxTokens: 1024, temperature: 0.7 },
      })
    );

    const stopReason = response.stopReason;
    const outputMessage = response.output?.message;
    if (!outputMessage) throw new Error('No output message from Bedrock');

    // Append assistant turn
    bedrockMessages.push({ role: 'assistant', content: outputMessage.content ?? [] });

    if (stopReason === 'end_turn') {
      const textBlock = outputMessage.content?.find(
        (b): b is ContentBlock => 'text' in b && typeof b.text === 'string'
      );
      return textBlock?.text ?? '';
    }

    if (stopReason === 'tool_use') {
      // Execute each tool call and collect results
      const toolResults: ToolResultBlock[] = [];
      for (const block of outputMessage.content ?? []) {
        if ('toolUse' in block && block.toolUse) {
          const { toolUseId, name, input } = block.toolUse;
          try {
            const resultText = await toolHandler(
              name ?? '',
              (input as Record<string, unknown>) ?? {}
            );
            toolResults.push({
              toolUseId: toolUseId ?? '',
              content: [{ text: resultText }],
            });
          } catch (err) {
            toolResults.push({
              toolUseId: toolUseId ?? '',
              content: [{ text: `Error: ${(err as Error).message}` }],
              status: 'error',
            });
          }
        }
      }

      // Send tool results back as a user turn
      bedrockMessages.push({
        role: 'user',
        content: toolResults.map((r) => ({ toolResult: r })),
      });
    } else {
      // Unknown stop reason — return whatever text we have
      const textBlock = outputMessage.content?.find(
        (b): b is ContentBlock => 'text' in b && typeof b.text === 'string'
      );
      return textBlock?.text ?? '';
    }
  }

  return 'I apologize — I hit an internal limit. Please try again.';
}
