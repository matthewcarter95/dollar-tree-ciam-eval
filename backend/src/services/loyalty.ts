import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

const POINTS_FUNCTION_URL = 'https://fvshdsmbhtjtxpoddptzruchoe0lrrta.lambda-url.us-east-1.on.aws/';
const COUPON_FUNCTION_ARN = 'arn:aws:lambda:us-east-1:204352680806:function:RetailPointsCoupon';
const TRACKER_FUNCTION_ARN = 'arn:aws:lambda:us-east-1:204352680806:function:RetailLoyaltyPointsTracker';

export interface LoyaltyData {
  loyaltyId: number | string;
  customeridentifier: string;
  totalPoints: number;
}

export interface CouponResult {
  success: boolean;
  pointsEarned?: number;
  newBalance?: number;
  message?: string;
  [key: string]: unknown;
}

export async function getLoyaltyPoints(loyaltyId: string | number): Promise<LoyaltyData> {
  const url = `${POINTS_FUNCTION_URL}?loyaltyId=${encodeURIComponent(String(loyaltyId))}`;
  const res = await fetch(url);
  // Treat 404/204 as zero points rather than an error
  if (res.status === 404 || res.status === 204) {
    return { loyaltyId, customeridentifier: '', totalPoints: 0 };
  }
  if (!res.ok) {
    throw new Error(`Loyalty tracker returned ${res.status}: ${await res.text()}`);
  }
  const data = await res.json() as LoyaltyData;
  return { ...data, totalPoints: data.totalPoints ?? 0 };
}

export async function trackLoyaltyPoints(loyaltyId: string | number, points: number): Promise<void> {
  // RetailLoyaltyPointsTracker uses Lambda Function URL v2 format.
  // PUT { loyaltyId: number, points: number } in the body — creates the record if new,
  // otherwise increments totalPoints by `points`. GET is read-only.
  const payload = JSON.stringify({
    version: '2.0',
    requestContext: { http: { method: 'PUT' } },
    body: JSON.stringify({ loyaltyId: Number(loyaltyId), points }),
  });
  try {
    const resp = await lambdaClient.send(
      new InvokeCommand({ FunctionName: TRACKER_FUNCTION_ARN, Payload: Buffer.from(payload) })
    );
    console.log('[loyalty] tracker response:', Buffer.from(resp.Payload ?? []).toString('utf8'));
  } catch (err) {
    // Non-fatal — log so ops can investigate without blocking the redemption response
    console.error('[loyalty] RetailLoyaltyPointsTracker invocation error:', err);
  }
}

export async function redeemCoupon(
  loyaltyId: string | number,
  couponCode: string
): Promise<CouponResult> {
  // RetailPointsCoupon returns { couponId, points } (not { success, pointsEarned }).
  const innerBody = JSON.stringify({ loyaltyId, couponId: couponCode });
  const payload = JSON.stringify({ body: innerBody });

  const response = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: COUPON_FUNCTION_ARN,
      Payload: Buffer.from(payload),
    })
  );
  const rawStr = Buffer.from(response.Payload ?? []).toString('utf8');
  const envelope = JSON.parse(rawStr) as { statusCode?: number; body?: string };

  const result: CouponResult = envelope.body
    ? (JSON.parse(envelope.body) as CouponResult)
    : (JSON.parse(rawStr) as CouponResult);

  console.log('[loyalty] coupon result:', JSON.stringify(result));

  // Coupon Lambda returns `points`; normalise to pointsEarned for downstream consistency
  const pointsEarned = result.pointsEarned ?? (result.points as number | undefined);
  if (pointsEarned && pointsEarned > 0) {
    await trackLoyaltyPoints(loyaltyId, pointsEarned);
    result.pointsEarned = pointsEarned;
    result.success = true;
  }

  return result;
}
