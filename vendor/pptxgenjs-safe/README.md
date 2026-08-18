# Reviewed PptxGenJS distribution

This directory contains the published PptxGenJS 4.0.1 CommonJS bundle, ES module bundle, type declaration, and MIT license. The files come from the official `pptxgenjs@4.0.1` npm package.

Deep-Mix vendors this reviewed distribution because PptxGenJS 4.0.1 declares `image-size` even though neither published runtime bundle imports it. The latest available `image-size` release has unpatched infinite-loop advisories for ICNS, JXL, and HEIF parsing. Removing that unused dependency keeps the executable PptxGenJS code unchanged while eliminating the unreachable vulnerable parser from production installs.

Deep-Mix independently accepts only bounded, in-memory PNG or JPEG presentation images before invoking PptxGenJS. Remove this vendor copy after upstream publishes a release without the vulnerable dependency and the normal release gate passes against it.
