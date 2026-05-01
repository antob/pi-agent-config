# List all the just commands
default:
    @just --list

# Update PI
update:
    # Update globally installed PI
    bun update -g --latest @mariozechner/pi-ai @mariozechner/pi-coding-agent @mariozechner/pi-tui
    # Update locally installed dependencies
    bun update --latest 
