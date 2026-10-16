ARG TOOLCHAIN_IMAGE=cothink-build-validator@sha256:5879132a5e9a30001eb3aff1655af70bc2681d80cba7666e66d12a21d726d1ce
ARG NODE_BASE_IMAGE=node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
FROM ${TOOLCHAIN_IMAGE} AS donor
FROM ${NODE_BASE_IMAGE} AS assembly
COPY --from=donor /opt/toolchain /opt/toolchain
COPY tools/agent-sync-validator/*.mjs /opt/validator/
ARG EXPECTED_NODE_VERSION
RUN node -e 'if(process.versions.node!==process.env.EXPECTED_NODE_VERSION)process.exit(1)' && chmod -R a+rX /opt/toolchain /opt/validator
FROM scratch
COPY --from=assembly / /
ENV PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp LANG=C.UTF-8
USER 65532:65532
ENTRYPOINT ["node"]
CMD ["/opt/validator/supervisor.mjs"]
