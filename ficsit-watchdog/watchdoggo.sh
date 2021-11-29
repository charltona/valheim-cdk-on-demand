#!/bin/bash
## Thanks to github.com/doctorray117/minecraft-ondemand
## Required Environment Variables

[ -n "$CLUSTER" ] || { echo "CLUSTER env variable must be set to the name of the ECS cluster" ; exit 1; }
[ -n "$SERVICE" ] || { echo "SERVICE env variable must be set to the name of the service in the $CLUSTER cluster" ; exit 1; }
[ -n "$SERVERNAME" ] || { echo "SERVERNAME env variable must be set to the full A record in Route53 we are updating" ; exit 1; }
[ -n "$DNSZONE" ] || { echo "DNSZONE env variable must be set to the Route53 Hosted Zone ID" ; exit 1; }
[ -n "$STARTUPMIN" ] || { echo "STARTUPMIN env variable not set, defaulting to a 10 minute startup wait" ; STARTUPMIN=10; }
[ -n "$SHUTDOWNMIN" ] || { echo "SHUTDOWNMIN env variable not set, defaulting to a 20 minute shutdown wait" ; SHUTDOWNMIN=20; }

function send_notification ()
{
  [ "$1" = "startup" ] && MESSAGETEXT="Satisfactory server operational @ flightfactory.link"
  [ "$1" = "shutdown" ] && MESSAGETEXT="Powering down Satisfactory server"

  ## Twilio Option
  [ -n "$TWILIOFROM" ] && [ -n "$TWILIOTO" ] && [ -n "$TWILIOAID" ] && [ -n "$TWILIOAUTH" ] && \
  echo "Twilio information set, sending $1 message" && \
  curl --silent -XPOST -d "Body=$MESSAGETEXT" -d "From=$TWILIOFROM" -d "To=$TWILIOTO" "https://api.twilio.com/2010-04-01/Accounts/$TWILIOAID/Messages" -u "$TWILIOAID:$TWILIOAUTH"

  ## SNS Option
  [ -n "$SNSTOPIC" ] && \
  echo "SNS topic set, sending $1 message" && \
  aws sns publish --topic-arn "$SNSTOPIC" --message "$MESSAGETEXT"

   ## Slack Webhook Option
  [ -n "$SLACKWEBHOOK" ] && \
  echo "Slack webhook URL set, sending $1 message" && \
  curl --silent --data "{\"text\":\"$MESSAGETEXT\"}" --header "Content-Type: application/json" $SLACKWEBHOOK

     ## Discord Webhook
    [ -n "$DISCORD_WEBHOOK" ] && \
    echo "Discord URL set, sending $1 message" && \
    curl --silent --data "{\"content\":\"$MESSAGETEXT\"}" --header "Content-Type: application/json" $DISCORD_WEBHOOK
}

function zero_service ()
{
  send_notification shutdown
  echo Setting desired task count to zero.
  aws ecs update-service --cluster $CLUSTER --service $SERVICE --desired-count 0
  exit 0
}

function sigterm ()
{
  ## upon SIGTERM set the service desired count to zero
  echo "Received SIGTERM, terminating task..."
  zero_service
}
trap sigterm SIGTERM

## get task id from the Fargate metadata
TASK=$(curl -s ${ECS_CONTAINER_METADATA_URI_V4}/task | jq -r '.TaskARN' | awk -F/ '{ print $NF }')
echo I believe our task id is $TASK

## get eni from from ECS
ENI=$(aws ecs describe-tasks --cluster $CLUSTER --tasks $TASK --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value | [0]" --output text)
echo I believe our eni is $ENI

## get public ip address from EC2
PUBLICIP=$(aws ec2 describe-network-interfaces --network-interface-ids $ENI --query 'NetworkInterfaces[0].Association.PublicIp' --output text)
echo "I believe our public IP address is $PUBLICIP"

## update public dns record
echo "Updating DNS record for $SERVERNAME to $PUBLICIP"
## prepare json file
cat << EOF >> satisfactory-dns.json
{
  "Comment": "Fargate Public IP change for Satisfactory Server",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "$SERVERNAME",
        "Type": "A",
        "TTL": 30,
        "ResourceRecords": [
          {
            "Value": "$PUBLICIP"
          }
        ]
      }
    }
  ]
}
EOF
aws route53 change-resource-record-sets --hosted-zone-id $DNSZONE --change-batch file://satisfactory-dns.json

## Wait for Satisfactory server to start
echo "Waiting for Satisfactory game port to start"
echo "If we are stuck here, the Satisfactory container probably failed to start.  Waiting 20 minutes just in case..."
COUNTER=0
while true
do
  netstat -aun | grep :7777 && break
  sleep 1
  COUNTER=$(($COUNTER + 1))
  if [ $COUNTER -gt 1200 ] ## server has not been detected as starting within 20 minutes
  then
    echo 10 minutes elapsed without a minecraft server starting server listening, terminating.
    zero_service
  fi
done
echo "Satisfactory Game Server Detected"

## Send startup notification message
send_notification startup

#echo "Checking every 5 seconds for active UDP traffic, up to $STARTUPMIN minutes..."
#COUNTER=0
#BYTES_SENT=0
#while [ $CONNECTED -lt 1 ]
#do
#  echo Waiting for connection, minute $COUNTER out of $STARTUPMIN...
#  BYTES_SENT =$(netstat -aun | grep ":7777" | awk '{print $2}')
#  [ "$EDITION" == "java" ] && CONNECTIONS=$(netstat -atn | grep :25565 | grep ESTABLISHED | wc -l)
#  [ "$EDITION" == "bedrock" ] && CONNECTIONS=$((echo -en "$BEDROCKPING" && sleep 1) | ncat -w 1 -u 127.0.0.1 19132 | cut -c34- | awk -F\; '{ print $5 }')
#  [ -n "$CONNECTIONS" ] || CONNECTIONS=0
#  CONNECTED=$(($CONNECTED + $CONNECTIONS))
#  COUNTER=$(($COUNTER + 1))
#  if [ $CONNECTED -gt 0 ] ## at least one active connection detected, break out of loop
#  then
#    break
#  fi
#  if [ $COUNTER -gt $STARTUPMIN ] ## no one has connected in at least these many minutes
#  then
#    echo $STARTUPMIN minutes exceeded without a connection, terminating.
#    zero_service
#  fi
#  ## only doing short sleeps so that we can catch a SIGTERM if needed
#  for i in $(seq 1 59) ; do sleep 1; done
#done
#
#echo "We believe a connection has been made, switching to shutdown watcher."
#COUNTER=0
#while [ $COUNTER -le $SHUTDOWNMIN ]
#do
#  [ "$EDITION" == "java" ] && CONNECTIONS=$(netstat -atn | grep :25565 | grep ESTABLISHED | wc -l)
#  [ "$EDITION" == "bedrock" ] && CONNECTIONS=$((echo -en "$BEDROCKPING" && sleep 1) | ncat -w 1 -u 127.0.0.1 19132 | cut -c34- | awk -F\; '{ print $5 }')
#  [ -n "$CONNECTIONS" ] || CONNECTIONS=0
#  if [ $CONNECTIONS -lt 1 ]
#  then
#    echo "No active connections detected, $COUNTER out of $SHUTDOWNMIN minutes..."
#    COUNTER=$(($COUNTER + 1))
#  else
#    [ $COUNTER -gt 0 ] && echo "New connections active, zeroing counter."
#    COUNTER=0
#  fi
#  for i in $(seq 1 59) ; do sleep 1; done
#done
#
#echo "$SHUTDOWNMIN minutes elapsed without a connection, terminating."
#zero_service