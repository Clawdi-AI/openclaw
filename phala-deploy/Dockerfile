FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Layer 1: System packages + openssh-server (Docker binaries mounted from host)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git bash tmux openssh-server unzip \
      iptables lsb-release sudo && \
    update-alternatives --set iptables /usr/sbin/iptables-legacy && \
    update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Docker static binaries + compose plugin (~80MB vs ~280MB for docker-ce)
ARG DOCKER_VERSION=27.5.1
ARG COMPOSE_VERSION=2.32.4
RUN mkdir -p /usr/local/lib/docker/cli-plugins && \
    curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" | \
    tar xz --strip-components=1 -C /usr/local/bin && \
    curl -fsSL "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose && \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# SSH config: permit root login with keys
RUN mkdir -p /var/run/sshd && \
    sed -i 's/#PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config

# Layer 2: Node.js 22 via nodesource
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    corepack enable && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Layer 3: Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Layer 4: Linuxbrew (Homebrew)
RUN useradd -m -s /bin/bash linuxbrew && \
    echo 'linuxbrew ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers
RUN NONINTERACTIVE=1 su - linuxbrew -c \
    'bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
ENV HOMEBREW_PREFIX="/home/linuxbrew/.linuxbrew"
ENV PATH="${HOMEBREW_PREFIX}/bin:${HOMEBREW_PREFIX}/sbin:${PATH}"

# Layer 5: Install build-essential, install OpenClaw from tarball, then purge build tools + cache
COPY phala-deploy/openclaw.tgz /tmp/openclaw.tgz
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential && \
    npm install -g /tmp/openclaw.tgz && \
    rm -f /tmp/openclaw.tgz && \
    apt-get purge -y --auto-remove build-essential && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /root/.npm /tmp/* /usr/include

# Layer 6: Shell environment
RUN echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> /root/.bashrc && \
    echo 'export PATH="/root/.bun/bin:$PATH"' >> /root/.bashrc

# rclone for encrypted S3 mount (single static binary, ~50MB)
ARG RCLONE_VERSION=1.73.0
RUN curl -fsSL "https://github.com/rclone/rclone/releases/download/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-amd64.zip" \
      -o /tmp/rclone.zip && \
    unzip -j /tmp/rclone.zip '*/rclone' -d /usr/local/bin && \
    chmod +x /usr/local/bin/rclone && \
    rm /tmp/rclone.zip

# Install fuse3 for rclone mount
RUN apt-get update && \
    apt-get install -y --no-install-recommends fuse3 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY phala-deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=15s --start-period=60s --retries=3 \
  CMD openclaw channels status --probe >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/entrypoint.sh"]
