#!/usr/bin/env bash

function check_result {
  if [ "0" -ne "$?" ]
  then
    echo $1
    exit 1
  fi
}

if [ "$UID" -ne "0" ]
then
  echo Must be run as root.
  echo $UID
  exit 1
fi

DIR=$(dirname $0)

NODE=$DIR/../node

pushd $NODE >/dev/null
NODE=$PWD

if [ ! -f "$NODE/node" ]
then
  echo Please compile the included node.js package before running Tether!
  echo cd $NODE
  echo ./configure
  echo make
  exit 1
fi

popd

echo Starting Tether...
cd $DIR/../node-tuntap
../linux/adb start-server
$NODE/node tether.js
