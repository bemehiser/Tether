interfaces=$(ifconfig -l)
for interface in $interfaces
do
  if [[ "$interface" == *vmnet* ]]
  then
    continue
  fi
  ipv4=$(ifconfig $interface | grep 'inet ' | cut -d ' ' -f 2 | grep -v 127.0.0.1 | grep -v 10.0.0.1)
  if [ ! -z "$ipv4" ]
  then
    gateway=$(route get default -ifscope $interface | grep gateway | cut -d : -f 2)
    route add -ifscope $interface default $gateway > /dev/null 2> /dev/null
    echo $interface $ipv4
  fi
done
