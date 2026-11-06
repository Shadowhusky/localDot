Use your built-in image generation tool (image_gen). This is for a promo cover; I will composite the images myself, so I need clean transparent cut-outs, nothing else.

Reference images (look at them first and pass the first one to the image tool as the reference):
1. ./localdot-douyin-cover-20261017-v3.png — the approved October cover. It is the absolute authority for the six mascots: their egg proportions, pearly white ceramic material, black happy crescent eyes, every costume, and the warm studio lighting.
2. ./localdot-landscape-en-20261017-v2.png — the same six, a second view.

Make SIX separate images, one mascot per image, each a full-body cut-out on a TRUE TRANSPARENT background (PNG with alpha; background: transparent). Square 1024x1024. The mascot is centred, fills about 70% of the frame height, and is complete with a clear empty margin on every side (nothing touches or crosses the edge: hat tips, tassels, scarf fringe, headphone band all inside). No floor, no ground shadow, no backdrop, no glow halo outside the body, no text, no logo, no extra objects.

Shared look for all six, matching reference 1 exactly: pearly white smooth egg-shaped ceramic body, slightly wider at the bottom, no arms, no legs, no mouth; two black glossy happy crescent eyes (upside-down U arcs) set in the upper half; soft key light from the upper left, a warm gentle rim light from behind on the right edge, soft occlusion where clothing meets the body; premium cute 3D product render; seen from straight in front at eye level, upright, facing the camera.

The six, each with exactly its own outfit from the reference and nothing more:
1. coder: wearing a charcoal-black hoodie that wraps the lower half of the body, hood down around the neck, two pale grey drawstrings with silver tips hanging at the front. File: dot-coder.png
2. researcher: black graduation mortarboard sitting on top with a gold tassel hanging at one side, and thin round gold wire glasses around the eyes. File: dot-researcher.png
3. finance: a navy suit jacket wrapping the lower half, white shirt collar and a red tie at the front. File: dot-finance.png
4. video editor: black over-ear headphones over the top of the head with the ear cups at the sides, and a curled brown handlebar moustache under the eyes. File: dot-video.png
5. designer: a raspberry-red beret tilted on top with a small stalk, and a mustard-yellow knitted scarf wrapped around the lower body with a fringed end hanging at the front. File: dot-designer.png
6. everyday: plain white dot, no clothing or accessory at all. File: dot-everyday.png

Use the same lighting, scale, eye style and camera for all six so they sit together as one set.

Save each final PNG (keep the alpha channel; do not flatten onto a colour, do not paint a checkerboard) into the folder ./update-real-art/ with the file names above. Create the folder if needed. Do not overwrite or modify any other file in this directory. Beside each PNG save a .prompt.txt with the exact prompt you used. After saving, check each file really has transparency (for example with `sips -g hasAlpha` and by confirming the corners are fully transparent) and report the result per file. If the tool cannot produce real transparency, say so plainly instead of faking it.
