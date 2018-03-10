# ClockworkMod Tether (Linux Driver)

This is a publicly edited version of the [publically available source code](http://download.clockworkmod.com/tether/Tether.apk), owned by [ClockworkMod](https://www.clockworkmod.com/). To use this, you need the [ClockworkMod Tether app](https://play.google.com/store/apps/details?id=com.koushikdutta.tether), available from the [Google Play Store](https://play.google.com/store).

#### Running Tether on Linux

At the top level directory of the package, run

    sudo linux/run.sh

On the first run of Tether, node.js will be compiled. This will take a few minutes.

#### Compiling for development

    cd node
    make distclean
    ./configure --without-snapshot
    CXXFLAGS=-fpermissive make
