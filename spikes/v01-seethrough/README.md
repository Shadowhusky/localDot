# V0-1: layer split with See-through

Splits one original anime bust into rig layers using the hosted See-through demo.

    uv sync
    # put the input at out/input.png (out/ is git-ignored)
    uv run python run.py 1280

Outputs land in `out/res<resolution>/`: `layered.psd`, `layers/*.webp`, `contact-sheet.png`,
`report.json`.
