{
  "id": "/",
  "name": "{{displayName}}",
  "short_name": "{{displayName}}",
  "description": "{{copy.webDescription}}",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "display_override": ["standalone", "minimal-ui"],
  "orientation": "any",
  "background_color": "{{branding.webBackground}}",
  "theme_color": "{{branding.webTheme}}",
  "lang": "en",
  "dir": "auto",
  "categories": [{{webCategories|jsonList}}],
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" },
    { "src": "/icons/badge-96.png", "sizes": "96x96", "type": "image/png", "purpose": "monochrome" }
  ],
  "shortcuts": [
    {
      "name": "Inbox",
      "short_name": "Inbox",
      "description": "Sessions waiting for you",
      "url": "/?shortcut=inbox",
      "icons": [{ "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" }]
    }
  ],
  "prefer_related_applications": false
}
