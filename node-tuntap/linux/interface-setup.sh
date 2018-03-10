if [ -z "$1" -o -z "$2" ]
then
	echo $0 ipaddress device
	echo ex: $0 10.0.0.1 tun0
	exit 1
fi

ifconfig $2 $1/24 $1
route add default $2

echo domain localdomain >> /etc/resolv.conf
echo search localdomain >> /etc/resolv.conf
echo nameserver 8.8.8.8 >> /etc/resolv.conf

