# SPDX-License-Identifier: AGPL-3.0-only
# The PDF text reader for people's uploads (server/src/uploads.ts): poppler's pdfinfo and pdftotext,
# from Alpine's own packages, on the official Alpine image pinned by digest. Nothing else is added.
# The server runs it with no network, 256 MB, one CPU, a read-only file system and no capabilities.
# Build it, and record its image ID, as for the Hermes image:
#   docker build -t circlechat/pdftext:latest images/pdftext
FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --no-cache poppler-utils && pdftotext -v && pdfinfo -v
USER 65534:65534
WORKDIR /tmp
LABEL circlechat.image="pdftext"
