# List all the just commands
default:
    @just --list

# Update PI
update:
    # Update globally installed PI
    bun update -g --latest @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-tui
    # Update locally installed dependencies
    bun update --latest 
