# GENERATED from release.yml.tpl by `pnpm identity:generate`; every name in it
# comes from product.json (MX-T7, D-36). Edit the template, not this file.
#
# A tag builds every Linux artifact for both architectures, hashes them into one
# SHA256SUMS, attests them to this workflow, and publishes them as a release
# with install.sh alongside.
#
# This workflow runs `scripts/release/*.sh` and nothing else. That is the point:
# the same three commands produce the same set of files on a laptop, so a
# release is never blocked on CI being available, and a reviewer reading this
# file is reading the build.
#
#   scripts/release/build-linux.sh --arch x64   --out release
#   scripts/release/build-linux.sh --arch arm64 --out release   (on an arm64 box)
#   scripts/release/publish.sh --tag v0.1.0 --dir release
#
# The one thing a laptop cannot produce is the build attestation in the
# `attest` step: Sigstore binds the artifacts to *this* workflow, this
# repository and this commit, so it can only be minted by a run here.
# install.sh *requires* it: a build with no provenance is refused unless the
# person passes --allow-unattested out loud, and a provenance check that fails
# is fatal with no flag at all. A hand-built release is therefore installable,
# but only by someone who said they knew it was hand-built.
#
# Two rules this file keeps and a reader should check it still keeps:
#
#   - **Every action is pinned to a commit SHA**, with the version it was in a
#     trailing comment. `@v4` is a tag the action's owner can move, and the
#     `publish` job below holds the release signing key and the Sigstore token,
#     so a moved tag there is a signed and attested release built by someone
#     else's code. Bump a pin by resolving the tag to a SHA on purpose.
#   - **No `${{ }}` expansion inside a `run:` block.** `inputs.tag` is a string
#     a person types; substituted into a shell line it is a shell line. Every
#     value a run step needs arrives through `env:` and is read as "$VAR",
#     which the shell never re-parses.

name: release

on:
  push:
    tags: ["v*"]
  workflow_dispatch:
    inputs:
      tag:
        description: An existing tag to build and publish
        required: true
        type: string

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  build:
    name: build ${{ matrix.arch }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - arch: x64
            runner: ubuntu-24.04
          # GitHub's hosted arm64 Linux runners. They are billed on private
          # repositories; a self-hosted arm64 runner with the `linux` and
          # `ARM64` labels is a drop-in replacement here. There is no
          # cross-compile option: the bundled Node, the prebuilt keyring binding
          # and the AppImage runtime are all native to the build machine, so an
          # arm64 artifact has to be built on arm64 hardware.
          - arch: arm64
            runner: ubuntu-24.04-arm
    runs-on: ${{ matrix.runner }}
    env:
      # electron-builder reads the pinned version out of node_modules/electron;
      # it downloads the dist it packages itself. The npm postinstall download is
      # ~120 MB of binary this job never launches.
      ELECTRON_SKIP_BINARY_DOWNLOAD: "1"
      # The one value a person can type. It reaches `run:` through the
      # environment and never through string substitution.
      {{env.tag}}: ${{ inputs.tag || github.ref_name }}
      {{env.arch}}: ${{ matrix.arch }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ inputs.tag || github.ref }}

      - uses: pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320 # v5.0.0

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
          cache: pnpm

      # fpm shells out to these for the .deb and .rpm targets. electron-builder
      # downloads fpm itself, but not the tools fpm drives.
      - name: system packaging tools
        run: sudo apt-get update && sudo apt-get install --no-install-recommends -y rpm binutils

      - name: build
        run: scripts/release/build-linux.sh --arch "{{env.arch|shellvar}}" --out release

      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: linux-${{ matrix.arch }}
          path: release/
          if-no-files-found: error
          retention-days: 7

  publish:
    name: publish
    needs: build
    runs-on: ubuntu-24.04
    permissions:
      contents: write # create the release and upload its assets
      id-token: write # mint the Sigstore certificate for the attestation
      attestations: write # record the attestation against this repository
    env:
      # `secrets` is not one of the contexts a step-level `if:` can read, so the
      # secret is lifted into the environment here and the step below tests that
      # instead. An unset secret expands to the empty string.
      {{env.releaseKeyPem}}: ${{ secrets.{{env.releaseKey}} }}
      {{env.packageSigningKey}}: ${{ secrets.{{env.packageSigningKey}} }}
      {{env.tag}}: ${{ inputs.tag || github.ref_name }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ inputs.tag || github.ref }}

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24

      - name: package-repository tools
        run: sudo apt-get update && sudo apt-get install --no-install-recommends -y apt-utils createrepo-c dpkg-dev gnupg rpm

      # Every architecture's artifacts, flattened into one directory: one
      # release, one manifest, one set of hashes.
      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          pattern: linux-*
          merge-multiple: true
          path: release

      # Optional. Without it the release is unsigned and install.sh says so;
      # with it, the manifest carries a signature made by a key that never
      # existed on a build machine before this step and does not survive it.
      - name: release signing key
        if: ${{ env.{{env.releaseKeyPem}} != '' }}
        run: |
          mkdir -p ~/.config/{{dirName}}
          umask 077
          printf '%s' "{{env.releaseKeyPem|shellvar}}" > ~/.config/{{dirName}}/release-key.pem

      - name: package-repository signing key
        run: |
          test -n "{{env.packageSigningKey|shellvar}}" || { echo "::error::{{env.packageSigningKey}} is required"; exit 1; }
          package_key_home="$RUNNER_TEMP/package-signing"
          mkdir -p "$package_key_home"
          chmod 700 "$package_key_home"
          printf '%s' "{{env.packageSigningKey|shellvar}}" | gpg --homedir "$package_key_home" --batch --import
          echo "GNUPGHOME=$package_key_home" >> "$GITHUB_ENV"

      # Sign the RPM files before the release manifest and provenance are made,
      # then build the APT/DNF indexes from those exact package bytes.
      - name: signed native package repositories
        run: scripts/release/package-repositories.sh --dir release --out package-repositories

      - uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0
        with:
          path: package-repositories

      # Assemble the exact bytes that will be uploaded: SHA256SUMS over every
      # artifact plus install.sh, signed if a key is configured. Nothing is
      # published yet, because the attestation below has to cover these bytes.
      # The attestation below says "this came from {{name}}'s release workflow at
      # this commit", and install.sh believes it. So the commit has to be one a
      # tag points at: `workflow_dispatch` takes a free-form string, and without
      # this a branch — or a fork's ref — would be published as a release.
      - name: the ref is a tag
        run: |
          git fetch --tags --force --depth=1 origin || true
          if [ -z "$(git tag --points-at HEAD)" ]; then
            echo "::error::{{env.tag|shellvar}} does not name a tag: refusing to attest and publish a non-tag commit."
            exit 1
          fi

      - name: stage the release
        run: scripts/release/publish.sh --stage-only --tag "{{env.tag|shellvar}}" --dir release

      # Install the real artifact, from the real manifest, the way a person
      # will — into a throwaway HOME on this runner. A release that cannot be
      # installed must not be published, and finding that out here costs a
      # minute rather than a stranger's afternoon.
      - name: install what is about to be published
        run: scripts/release/verify-install.sh --release release

      # The one check a hand-built release cannot fake: Sigstore binds every
      # file below to this workflow, this repository and this commit.
      # install.sh runs `gh attestation verify` against it and treats a failure
      # as fatal.
      - uses: actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2
        id: provenance
        with:
          # Everything in the directory, install.sh and the manifest included —
          # a glob that names formats would fail the build the day a format is
          # added or dropped from electron-builder.yml.
          subject-path: release/*

      # Public installs do not need a GitHub account. Ship the signed Sigstore
      # bundle as an ordinary release asset so `gh attestation verify --bundle`
      # can verify it offline, without an API token. It stays outside `release/`:
      # the bundle cannot attest itself and is therefore not part of SHA256SUMS.
      - name: keep the offline provenance bundle
        run: cp "${{ steps.provenance.outputs.bundle-path }}" "$RUNNER_TEMP/provenance.jsonl"

      - name: publish the release
        env:
          GH_TOKEN: ${{ github.token }}
        run: scripts/release/publish.sh --tag "{{env.tag|shellvar}}" --dir release

      - name: publish the offline provenance bundle
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release upload "{{env.tag|shellvar}}" "$RUNNER_TEMP/provenance.jsonl" --repo "{{repository}}" --clobber

  deploy-package-repositories:
    name: deploy package repositories
    needs: publish
    runs-on: ubuntu-24.04
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: publish APT and DNF repositories
        id: deployment
        uses: actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1
