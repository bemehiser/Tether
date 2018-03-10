#!/usr/bin/env bash

echo Setting ip address, route, and DNS servers.

if [ -z "$1" -o -z "$2" ]
then
	echo $0 ipaddress device
	echo ex: $0 10.0.0.1 tun0
	exit 1
fi

ifconfig $2 $1/24 $1
route add 0/1 $1

scutil <<EOF
d.init
d.add Addresses * $1
d.add DestAddresses * $1
d.add InterfaceName $2
set State:/Network/Service/$2/IPv4
d.init
d.add ServerAddresses * 8.8.8.8 8.8.4.4
d.add SupplementalMatchDomains *
set State:/Network/Service/$2/DNS
EOF