# Thanks to github.com/doctorray117/minecraft-ondemand
FROM amazon/aws-cli

RUN yum install -y net-tools jq nmap-cat && \
    yum clean all

COPY ./watchdoggo.sh .

ENTRYPOINT ["./watchdoggo.sh"]