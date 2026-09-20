#!/bin/bash
# Quick deployment script for AMI Lifecycle Stack

set -e

echo "🚀 Deploying AMI Lifecycle Stack..."
echo ""

# Check if we're in the cdk directory
if [ ! -f "cdk.json" ]; then
    echo "❌ Error: Not in CDK directory. Please run from /cdk folder."
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Build TypeScript
echo "🔨 Building TypeScript..."
npm run build

# Deploy the stack
echo "☁️  Deploying AmiLifecycleStack..."
cdk deploy AmiLifecycleStack --require-approval never

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📋 Next steps:"
echo "  1. Check outputs for State Machine ARN"
echo "  2. Subscribe to SNS topic for failure notifications"
echo "  3. Test by stopping a gaming instance"
echo "  4. Monitor execution in Step Functions console"
echo ""
echo "📖 See IMPLEMENTATION-SUMMARY.md for complete guide"
