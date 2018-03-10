echo interface shutdown script

if [ -z "$1" ]
then
	echo $0 device
	echo ex: $0 tun0
	exit 1
fi

echo Checking ifconfig for clean shutdown...
TUN_STILL_EXISTS=$(ifconfig | grep $1)
if [ ! -z "$TUN_STILL_EXISTS" ]
then
  echo $1 device is still on ifconfig. Killing adb-server.
  echo You may need to disconnect and reconnecty our phone to use Tether again.
  DIR=$(dirname $0)
  $DIR/../../darwin/adb kill-server
else
    echo ifconfig checks out ok.
    echo Allowing adb to stay resident.
fi
