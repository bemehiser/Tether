interfaces=$(ifconfig -s | cut -d ' ' -f 1 | grep -v Iface)
for interface in $interfaces
do
  ipv4=$(ifconfig $interface | grep 'inet ' | cut -d : -f 2 | cut -d ' ' -f 1 | grep -v 127.0.0.1 | grep -v 10.0.0.1)
  if [ ! -z "$ipv4" ]
  then
    gateway=$(ip route show default oif $interface | awk '/default/ {print $3}')
    route add default gw $gateway dev $interface > /dev/null 2> /dev/null
    echo $interface $ipv4
  fi
done
