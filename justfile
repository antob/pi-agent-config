# List all the just commands
default:
    @just --list

# Update PI
update:
    # Update locally installed dependencies
    bun update --latest 
