# AMI Lifecycle Automation

This document describes the automated AMI creation and lifecycle management system for cloud gaming instances.

## Overview

The AMI Lifecycle Stack replaces the previous Lambda-based snapshot creation with a robust Step Functions workflow that handles:
- ✅ **Unlimited execution time** (no 15-minute Lambda timeout)
- ✅ **Tag-based filtering** (only instances with `SnapAndDelete: true`)
- ✅ **Spot instance compatibility** (handles persistent spot requests)
- ✅ **Automatic cleanup** (old AMIs, orphaned volumes)
- ✅ **Failure notifications** (SNS alerts)
- ✅ **Idempotent execution** (prevents duplicate AMI creation)

## Architecture

```
EC2 Instance Stopped
    ↓
EventBridge Rule (state: stopped)
    ↓
Lambda Filter Function (checks SnapAndDelete tag)
    ↓
Step Functions State Machine:
    1. CreateImage (NoReboot=true)
    2. WaitForImageAvailable (polling loop)
    3. TagAMI (apply Name tag)
    4. DescribeOldAMIs (find previous AMIs)
    5. CancelSpotRequest (prevent restart)
    6. TerminateInstance (with retries)
    7. WaitForTermination (polling loop)
    8. DeleteOrphanedVolumes (cleanup)
    ↓
Success / SNS Notification on Failure
```

## Key Components

### 1. Tag Filter Lambda
- **Location**: `cdk/src/ami-lifecycle/tag-filter.py`
- **Purpose**: Filter EventBridge events by checking for `SnapAndDelete: true` tag
- **Trigger**: EC2 Instance State-change Notification (stopped state)
- **Action**: Start Step Functions execution with idempotent name

### 2. Step Functions State Machine
- **Type**: Standard (supports unlimited duration)
- **Timeout**: 2 hours
- **States**: 8 states with retry/catch blocks
- **Logging**: CloudWatch Logs at `/aws/stepfunctions/gaming-ami-lifecycle`

### 3. Launch Template Configuration
- **Spot Behavior**: `instanceInterruptionBehavior: 'stop'`
- **Spot Type**: `spotInstanceType: 'persistent'`
- **Volume**: `deleteOnTermination: false`
- **Tags**: `SnapAndDelete: true` on both instance and volume

## How It Works

### Spot Instance Lifecycle
1. **Running**: Instance is active, gaming session in progress
2. **Stopped**: User stops instance OR spot interruption occurs
3. **EventBridge Trigger**: Stopped state triggers Lambda filter
4. **Tag Check**: Lambda verifies `SnapAndDelete: true` tag
5. **Workflow Start**: Step Functions begins AMI creation
6. **AMI Creation**: SSM creates AMI with `NoReboot: true` (45+ min for large volumes)
7. **Spot Cancel**: Cancel persistent spot request to prevent restart
8. **Termination**: Terminate instance
9. **Cleanup**: Delete old AMIs and orphaned volumes

### Idempotency
- **Execution Name**: `ami-creation-{instanceId}-{timestamp}`
- **Prevents**: Duplicate AMI creation if EventBridge triggers multiple times
- **Behavior**: Step Functions rejects duplicate execution names automatically

### Failure Handling
- **Retry Blocks**: Automatic retry with exponential backoff
- **Catch Blocks**: SNS notification on critical failures (CreateImage, TerminateInstance)
- **Dead Letter Queue**: Failed volume deletions sent to DLQ for retry
- **Continue on Failure**: Spot request cancellation failure doesn't stop workflow

## Deployment

### Prerequisites
```bash
cd cdk
npm install
```

### Deploy All Stacks
```bash
cdk deploy --all
```

### Deploy AMI Lifecycle Only
```bash
cdk deploy AmiLifecycleStack
```

### Outputs
- `StateMachineArn`: ARN for the Step Functions state machine
- `FailureTopicArn`: SNS topic for failure notifications
- `VolumeCleanupDlqUrl`: DLQ for failed volume cleanup

## Configuration

### Tag Requirements
All gaming instances MUST have these tags (automatically applied by launch template):
```typescript
{ Key: 'SnapAndDelete', Value: 'true' }
{ Key: 'Name', Value: 'GamingInstance/...' }
```

### Spot Instance Settings
```typescript
instanceMarketOptions: {
  marketType: 'spot',
  spotOptions: {
    maxPrice: '0.7',
    instanceInterruptionBehavior: 'stop',  // Stop instead of terminate
    spotInstanceType: 'persistent',        // Keep request active
  },
}
```

### Volume Settings
```typescript
blockDevices: [{
  deviceName: '/dev/sda1',
  volume: ec2.BlockDeviceVolume.ebs(100, {
    volumeType: ec2.EbsDeviceVolumeType.GP3,
    deleteOnTermination: false,  // Preserve for AMI creation
    encrypted: true,
  }),
}]
```

## Monitoring

### CloudWatch Logs
- **State Machine**: `/aws/stepfunctions/gaming-ami-lifecycle`
- **Lambda Filter**: `/aws/lambda/TagFilterFunction`

### Step Functions Console
Navigate to AWS Console → Step Functions → `gaming-ami-lifecycle` to view:
- Active executions
- Execution history
- Visual workflow graph
- Detailed state transitions

### SNS Notifications
Subscribe to `gaming-ami-creation-failures` topic for:
- CreateImage failures
- TerminateInstance failures
- Error details with instance ID and execution ID

## Troubleshooting

### Instance Restarts After Stop
**Problem**: Persistent spot request causes instance to restart when capacity returns.

**Solution**: Workflow cancels spot request in Step 5 before termination.

**Verify**: Check Step Functions execution for `CancelSpotRequest` state success.

### AMI Creation Takes Too Long
**Problem**: Large volumes (100GB+) can take 45+ minutes.

**Solution**: Standard Step Functions supports unlimited duration (2-hour timeout configured).

**Monitor**: Check `WaitForImage` state iterations in execution history.

### Orphaned Volumes
**Problem**: Volumes with `available` status not deleted.

**Solution**: Workflow includes `DeleteOrphanedVolumes` state with tag filtering.

**Manual Cleanup**: 
```bash
aws ec2 describe-volumes --filters "Name=status,Values=available" "Name=tag:SnapAndDelete,Values=true"
aws ec2 delete-volume --volume-id vol-xxxxx
```

### Duplicate AMI Creation
**Problem**: Multiple EventBridge events trigger workflow twice.

**Solution**: Idempotent execution names prevent duplicate runs.

**Verify**: Check Step Functions for rejected executions with same name.

## Cost Optimization

### AMI Storage
- **Retention**: Workflow keeps only latest AMI per instance
- **Old AMIs**: Automatically deregistered with snapshot deletion
- **Cost**: ~$0.05/GB-month for EBS snapshots

### Step Functions
- **Type**: Standard (not Express)
- **Cost**: $0.025 per 1,000 state transitions
- **Estimate**: ~$0.0002 per AMI creation (8 states)

### Lambda
- **Invocations**: 1 per stopped instance event
- **Duration**: ~100ms
- **Free Tier**: 1M requests/month free

## Migration from Lambda

### Old Stack (to be removed)
- `cdk/src/gaming-rig-persist/lambda_function.py`
- `cdk/src/gaming-rig-persist/cloud-rig-persist.yaml`

### Migration Steps
1. Deploy `AmiLifecycleStack`
2. Test with single instance stop
3. Verify AMI creation in Step Functions console
4. Remove old Lambda/SAM infrastructure
5. Update documentation

### Testing
```bash
# Stop a gaming instance
aws ec2 stop-instances --instance-ids i-xxxxx

# Monitor Step Functions execution
aws stepfunctions list-executions --state-machine-arn <arn>

# Check AMI creation
aws ec2 describe-images --owners self --filters "Name=tag:SnapAndDelete,Values=true"
```

## Security

### IAM Permissions
- **Step Functions**: EC2 full control (CreateImage, TerminateInstances, etc.)
- **Lambda Filter**: EC2 DescribeInstances, Step Functions StartExecution
- **EventBridge**: Pass role to Lambda

### Encryption
- **EBS Volumes**: Encrypted at rest
- **AMI Snapshots**: Inherit encryption from source volume
- **CloudWatch Logs**: Encrypted with AWS managed key

## References

- [AWS Step Functions](https://docs.aws.amazon.com/step-functions/)
- [EC2 Spot Instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-spot-instances.html)
- [AMI Creation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/creating-an-ami-ebs.html)
- [EventBridge Rules](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rules.html)
