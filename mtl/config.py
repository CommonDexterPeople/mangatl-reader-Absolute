"""
Shared constants used by more than one module.

This exists purely to break an import cycle: security.py needs USER_AGENT,
but server.py imports security.py, so USER_AGENT can't live in server.py
without security.py having to import back into it. Anything genuinely shared
by server.py and a mtl/ module belongs here; anything used by exactly one
module belongs in that module instead.
"""

# FIX #15 — MangaDex's API etiquette asks clients to identify themselves with
#   a descriptive User-Agent (ideally including contact info) so they can
#   reach out if a particular client instance misbehaves. Every request in
#   this script previously sent the same generic "MangaTL-Reader/1.0" string,
#   indistinguishable across every user running the tool. Centralise it here
#   as one constant — append your own contact info if redistributing this.
USER_AGENT = "MangaTL-Reader/1.0 (local single-user tool; run via python script)"
