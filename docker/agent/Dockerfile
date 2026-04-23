# AgentForge Claude Agent Container
# Based on Arch Linux with Claude Code CLI

FROM archlinux:latest

# Update system and install essentials
RUN pacman -Syu --noconfirm && \
    pacman -S --noconfirm \
        base-devel \
        git \
        curl \
        wget \
        vim \
        nano \
        openssh \
        jq \
        ripgrep \
        fd \
        bat \
        tree \
        htop \
        postgresql-libs \
        python \
        python-pip \
        unzip \
        tar \
        gzip \
        sudo \
        inotify-tools

# Install Node.js (LTS) via pacman
RUN pacman -S --noconfirm nodejs npm

# Install pnpm globally
RUN npm install -g pnpm

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user for agent
RUN useradd -m -s /bin/bash agent && \
    echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Create directories
RUN mkdir -p /workspace /specs /prompts /logs /completion /shared && \
    chown -R agent:agent /workspace /specs /prompts /logs /completion /shared

# Set up environment
ENV NODE_ENV=development
ENV PNPM_HOME=/home/agent/.local/share/pnpm
ENV PATH="$PNPM_HOME:/home/agent/.npm-global/bin:$PATH"
ENV CLAUDE_CODE_LOG_LEVEL=debug
ENV HOME=/home/agent

# Copy agent scripts
COPY scripts/ /scripts/
RUN chmod +x /scripts/*.sh && chown -R agent:agent /scripts

WORKDIR /workspace

# Switch to non-root user
USER agent

ENTRYPOINT ["/scripts/entrypoint.sh"]
CMD ["bash"]
