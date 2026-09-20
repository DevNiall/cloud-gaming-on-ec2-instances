# Pre-Deployment Checklist

## ✅ Implementation Complete

Both recommendations have been successfully implemented:

### ✅ Recommendation 1: Tag-Based Filtering (EventBridge → Lambda → Step Functions)
- [x] Lambda filter function created ([tag-filter.py](src/ami-lifecycle/tag-filter.py))
- [x] EventBridge rule configured for EC2 stopped state
- [x] Tag check validates `SnapAndDelete: true` before execution
- [x] Integrated with Step Functions via execution start

### ✅ Recommendation 2: Idempotent Execution Names
- [x] Execution name format: `ami-creation-{instanceId}-{timestamp}`
- [x] Step Functions automatically rejects duplicates
- [x] Timestamp from EventBridge event ensures uniqueness
- [x] Prevents duplicate AMI creation charges

## 📋 Deployment Checklist

### Before Deployment
- [ ] AWS CLI configured with correct credentials
- [ ] AWS region set to `eu-west-2` (or your preferred region)
- [ ] CDK CLI installed: `npm install -g aws-cdk`
- [ ] Node.js dependencies installed: `cd cdk && npm install`
- [ ] Review configuration in [cloud-gaming-on-ec2.ts](bin/cloud-gaming-on-ec2.ts)

### Deploy
```bash
cd cdk
./deploy-ami-lifecycle.sh
```

Or manually:
```bash
cd cdk
npm install
cdk deploy AmiLifecycleStack
```

### After Deployment
- [ ] Note the `StateMachineArn` output
- [ ] Note the `FailureTopicArn` output
- [ ] Subscribe to SNS topic for email/SMS notifications:
  ```bash
  aws sns subscribe \
    --topic-arn <FailureTopicArn> \
    --protocol email \
    --notification-endpoint your-email@example.com
  ```
- [ ] Confirm SNS subscription via email

## 🧪 Testing Checklist

### Initial Test
- [ ] Launch a gaming instance (or use existing one)
- [ ] Verify instance has `SnapAndDelete: true` tag
- [ ] Stop the instance via AWS Console or CLI
- [ ] Open Step Functions console
- [ ] Find execution named `ami-creation-i-xxxxx-...`
- [ ] Monitor execution progress through states
- [ ] Verify no errors in execution

### Validation
- [ ] AMI created successfully (check EC2 Console → AMIs)
- [ ] AMI has tags: `SnapAndDelete: true`, `SourceInstance`, `CreatedBy`
- [ ] Instance terminated (not just stopped)
- [ ] Spot request cancelled (if was spot instance)
- [ ] No orphaned volumes (EC2 Console → Volumes → filter available)
- [ ] Execution time reasonable (30-60 min for 100GB volume)

### Edge Cases
- [ ] Test with non-tagged instance (should NOT trigger workflow)
- [ ] Test stopping same instance twice quickly (idempotency check)
- [ ] Test with on-demand instance (spot cancellation should skip gracefully)
- [ ] Check CloudWatch Logs for Lambda and Step Functions

## 📊 Monitoring Checklist

### CloudWatch Logs
- [ ] Lambda filter logs: `/aws/lambda/AmiLifecycleStack-TagFilterFunction...`
- [ ] Step Functions logs: `/aws/stepfunctions/gaming-ami-lifecycle`

### Step Functions Console
- [ ] Navigate to AWS Console → Step Functions
- [ ] Open `gaming-ami-lifecycle` state machine
- [ ] Review execution history
- [ ] Check visual workflow graph
- [ ] Verify state transitions

### EC2 Resources
- [ ] AMIs: Should see latest AMI for each instance
- [ ] Volumes: No `available` volumes with `SnapAndDelete: true`
- [ ] Instances: Should be terminated (not stopped)
- [ ] Spot Requests: Should be cancelled or inactive

## 🔄 Migration Checklist

### Old Lambda Infrastructure (Remove After Testing)
- [ ] Test new workflow for 1-2 days
- [ ] Verify no issues with AMI creation
- [ ] Backup old Lambda code (already in git history)
- [ ] Delete CloudFormation stack for old Lambda
- [ ] Remove files:
  - [ ] `src/gaming-rig-persist/lambda_function.py`
  - [ ] `src/gaming-rig-persist/cloud-rig-persist.yaml`
- [ ] Update main README.md with new AMI lifecycle info

## 🚨 Rollback Plan

If issues occur:
1. Delete `AmiLifecycleStack`: `cdk destroy AmiLifecycleStack`
2. Re-deploy old Lambda infrastructure (from git history)
3. Report issue with logs and execution details

## 📚 Documentation Checklist

- [x] AMI-LIFECYCLE.md created (detailed documentation)
- [x] IMPLEMENTATION-SUMMARY.md created (implementation overview)
- [x] deploy-ami-lifecycle.sh created (deployment script)
- [x] DEPLOYMENT-CHECKLIST.md created (this file)
- [ ] Update main README.md with AMI lifecycle section
- [ ] Add troubleshooting section to main README.md

## ✅ Success Criteria

After deployment and testing, verify:
- ✅ No Lambda timeout errors
- ✅ AMI creation succeeds for 100GB+ volumes
- ✅ Only tagged instances trigger workflow
- ✅ Spot instances don't restart after AMI creation
- ✅ Old AMIs automatically cleaned up
- ✅ Orphaned volumes automatically deleted
- ✅ Failure notifications received via SNS
- ✅ Duplicate executions rejected (idempotency)
- ✅ Execution visible in Step Functions console

## 🎯 Key Metrics to Track

### Performance
- AMI creation time: Expected 30-60 min for 100GB volumes
- Workflow execution time: Expected 45-75 min total
- Success rate: Target >95%

### Cost
- Step Functions: ~$0.0002 per execution
- Lambda: ~$0.000001 per invocation
- Snapshot storage: ~$5/month per 100GB AMI

### Reliability
- Zero Lambda timeout errors
- All AMI creations complete successfully
- No orphaned resources

## 📞 Support

For issues or questions:
1. Check [AMI-LIFECYCLE.md](AMI-LIFECYCLE.md) troubleshooting section
2. Review CloudWatch Logs for error details
3. Check Step Functions execution history
4. Review [IMPLEMENTATION-SUMMARY.md](../IMPLEMENTATION-SUMMARY.md) for architecture

## 🔗 Quick Links

- [Implementation Summary](../IMPLEMENTATION-SUMMARY.md)
- [Detailed Documentation](AMI-LIFECYCLE.md)
- [Main CDK App](bin/cloud-gaming-on-ec2.ts)
- [AMI Lifecycle Stack](lib/ami-lifecycle-stack.ts)
- [Tag Filter Lambda](src/ami-lifecycle/tag-filter.py)
- [Base Stack (Launch Template)](lib/base.ts)
