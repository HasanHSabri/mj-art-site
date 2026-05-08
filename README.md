# MJ Art Site

Simple landing-page website for MJ's artwork.

Live site:
- https://hasanhsabri.github.io/mj-art-site/

Repo:
- https://github.com/HasanHSabri/mj-art-site

Project structure:
- `docs/` - website files served by GitHub Pages
- `docs/artwork/` - uploaded artwork images and inventory template

Current setup:
- single-page static site
- gallery with artwork detail dialog rendered from `docs/artworks.json`
- email inquiry flow
- placeholder space for bio, testimonials, and artwork metadata
- browser-only admin surface at `docs/admin.html` for editing and exporting artwork data

To update later:
- add more artwork photos to `docs/artwork/`
- fill artwork titles, medium, size, availability, and descriptions
- use `docs/admin.html` to edit metadata and export the updated `docs/artworks.json`
- add MJ bio
- add testimonials
- add real authentication and direct publishing when the site moves beyond static GitHub Pages

Deployment:
- GitHub Pages is configured from `main:/docs`
- pushing changes to `main` updates the live site
