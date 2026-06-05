# List all the just commands
default:
    @just --list

# Update PI
update:
    # Update globally installed PI
    pi update
    # Update locally installed dependencies
    bun update --latest 
