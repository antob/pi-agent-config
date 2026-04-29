# List all the just commands
default:
    @just --list

# Update PI
update:
    bun update -g @mariozechner/pi-coding-agent # Update globally installed PI
    bun update --latest # Update locally installed dependencies
