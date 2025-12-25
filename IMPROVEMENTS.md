# IMPROVEMENTS.md Implementation Status

## Implemented
- [x] **Scrolling**: Enabled `tmux` mouse mode for touch/scroll support.
- [x] **Session Persistence**: Switched to `tmux` backend.
- [x] **Token Auth**: Switched from HTTP Basic Auth to Path Token (`/token`) for better browser compatibility.
- [x] **Writable Mode**: Enabled `-W` for full interaction.

## Future Considerations (from User Requests)
- [ ] **Cloudflare Access (2FA)**: 
    - *Constraint*: Requires user to own a domain and configure Cloudflare Zero Trust (SAML/OIDC).
    - *Current State*: Using random high-entropy token path for "zero-setup" security.
    - *Recommendation*: For enterprise security, users should wrap this tool's localhost port with a manually configured `cloudflared tunnel run` that points to their Zero Trust organization.

- [ ] **Session Expiry**: Explicitly NOT implemented per user request to maintain persistent shell access.
