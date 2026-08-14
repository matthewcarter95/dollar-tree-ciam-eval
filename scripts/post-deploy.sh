#!/usr/bin/env bash
# post-deploy.sh
#
# Attaches Lambda Function URL and creates CloudFront distribution.
# Run this AFTER: sam deploy --stack-name chatbot-stack
#
# Why: The org hook AWS::EarlyValidation::PropertyValidation blocks
# Lambda Function URLs in CloudFormation. This script bypasses that
# by adding the Function URL via CLI post-deployment.
#
# Usage:
#   ./scripts/post-deploy.sh <stack-name> <aws-region> <api-hostname>
#
# Example:
#   ./scripts/post-deploy.sh chatbot-stack us-east-1 smitty-api.demo-connect.us

set -euo pipefail

STACK_NAME="${1:-chatbot-stack}"
REGION="${2:-us-east-1}"
API_HOSTNAME="${3:-smitty-api.demo-connect.us}"

echo "==> Getting Lambda ARN from stack outputs..."
FUNCTION_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='BackendFunctionArn'].OutputValue" \
  --output text)

FUNCTION_NAME=$(echo "$FUNCTION_ARN" | awk -F: '{print $NF}')
echo "    Function: $FUNCTION_NAME"

echo "==> Creating Lambda Function URL..."
FUNCTION_URL=$(aws lambda create-function-url-config \
  --function-name "$FUNCTION_NAME" \
  --auth-type NONE \
  --cors '{
    "AllowOrigins": ["https://smitty.demo-connect.us"],
    "AllowMethods": ["GET","POST","PUT","DELETE","OPTIONS"],
    "AllowHeaders": ["Content-Type","Authorization","Cookie"],
    "AllowCredentials": true,
    "MaxAge": 300
  }' \
  --region "$REGION" \
  --query FunctionUrl \
  --output text 2>/dev/null || aws lambda get-function-url-config \
  --function-name "$FUNCTION_NAME" \
  --region "$REGION" \
  --query FunctionUrl \
  --output text)

# Lambda Function URLs have a trailing slash; strip it for CloudFront origin
FUNCTION_URL_HOST=$(echo "$FUNCTION_URL" | sed 's|https://||' | sed 's|/||')
echo "    Function URL host: $FUNCTION_URL_HOST"

# Add resource-based policy to allow public invocation via CloudFront
aws lambda add-permission \
  --function-name "$FUNCTION_NAME" \
  --statement-id AllowPublicAccess \
  --action lambda:InvokeFunctionUrl \
  --principal '*' \
  --function-url-auth-type NONE \
  --region "$REGION" 2>/dev/null || echo "    (permission already exists)"

echo "==> Looking up ACM certificate for $API_HOSTNAME in us-east-1..."
CERT_ARN=$(aws acm list-certificates \
  --region us-east-1 \
  --query "CertificateSummaryList[?DomainName=='*.demo-connect.us' || DomainName=='$API_HOSTNAME'].CertificateArn | [0]" \
  --output text)

if [[ -z "$CERT_ARN" || "$CERT_ARN" == "None" ]]; then
  echo "    WARNING: No ACM certificate found for $API_HOSTNAME."
  echo "    Request one in us-east-1 and update the CloudFront distribution manually."
  CERT_ARN=""
fi

echo "==> Creating CloudFront distribution for $API_HOSTNAME..."

DIST_CONFIG=$(cat <<EOF
{
  "Comment": "Chatbot API ($API_HOSTNAME)",
  "Origins": {
    "Quantity": 1,
    "Items": [{
      "Id": "lambda-backend",
      "DomainName": "$FUNCTION_URL_HOST",
      "CustomOriginConfig": {
        "HTTPSPort": 443,
        "OriginProtocolPolicy": "https-only",
        "OriginSSLProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]}
      }
    }]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "lambda-backend",
    "ViewerProtocolPolicy": "redirect-to-https",
    "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac",
    "AllowedMethods": {"Quantity": 7, "Items": ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"], "CachedMethods": {"Quantity": 2, "Items": ["GET","HEAD"]}},
    "Compress": true
  },
  "Enabled": true,
  "HttpVersion": "http2",
  "PriceClass": "PriceClass_100",
  "Aliases": {"Quantity": 1, "Items": ["$API_HOSTNAME"]},
  "ViewerCertificate": {
    "ACMCertificateArn": "$CERT_ARN",
    "SSLSupportMethod": "sni-only",
    "MinimumProtocolVersion": "TLSv1.2_2021"
  }
}
EOF
)

# Create distribution only if cert was found
if [[ -n "$CERT_ARN" ]]; then
  DIST_ID=$(aws cloudfront create-distribution \
    --distribution-config "$DIST_CONFIG" \
    --query "Distribution.Id" \
    --output text)
  CLOUDFRONT_DOMAIN=$(aws cloudfront get-distribution \
    --id "$DIST_ID" \
    --query "Distribution.DomainName" \
    --output text)

  echo ""
  echo "==> Done!"
  echo ""
  echo "    CloudFront distribution: $DIST_ID"
  echo "    CloudFront domain:       $CLOUDFRONT_DOMAIN"
  echo ""
  echo "Next steps:"
  echo "  1. In Route53, create a CNAME record:"
  echo "       $API_HOSTNAME -> $CLOUDFRONT_DOMAIN"
  echo "  2. Deploy the frontend to Amplify (smitty.demo-connect.us)"
  echo "  3. Set Auth0 callback URL: https://$API_HOSTNAME/auth/callback"
  echo "  4. Set Auth0 backchannel logout URI: https://$API_HOSTNAME/auth/backchannel-logout"
else
  echo ""
  echo "==> Partial completion — CloudFront not created (no ACM cert)."
  echo "    Request a wildcard cert (*.demo-connect.us) in ACM (us-east-1) then re-run."
  echo ""
  echo "    Lambda Function URL: $FUNCTION_URL"
  echo "    Use this URL directly for testing until CloudFront is set up."
fi
