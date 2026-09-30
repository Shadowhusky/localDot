FROM lscr.io/linuxserver/webtop:ubuntu-xfce
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-venv at-spi2-core libreoffice-calc \
    libreoffice-writer libreoffice-gtk3 thunar xfce4-terminal mousepad xdotool imagemagick \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir cua-driver==0.30.4
ENV GTK_MODULES=gail:atk-bridge QT_ACCESSIBILITY=1
