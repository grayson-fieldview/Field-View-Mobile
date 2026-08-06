---
name: Hidden routes in the (tabs) group
description: How settings/edit-profile live inside (tabs) without breaking the custom FloatingTabBar
---
Detail screens (settings, edit-profile) live in `(tabs)` as hidden routes.

**Rule:** any new non-tab route in `(tabs)` must (1) be declared in `(tabs)/_layout.tsx` with `href: null` AFTER the four real tabs — FloatingTabBar renders `state.routes` by fixed index 0–3, so undeclared/reordered routes shift the bar — and (2) be added to FloatingTabBar's hide list (it returns null when the focused route is a hidden detail route), or the bar floats over the detail screen with no selected tab.

**Why:** custom tab bar draws fixed indexes and is invoked for every focused route in the group; `href: null` only removes the tab item, not the bar itself.

**How to apply:** adding any pushed screen inside `(tabs)`; screens render their own inline back-chevron header (tabs have headerShown: false).
