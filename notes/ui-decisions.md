# Image and Group result UI

Candidate cards show the actual raster, title, dimensions, license, author and a distinct provenance link. No candidate starts selected. Choosing one for a connected run does not apply Batch edits. The run's aggregate Apply remains separate.

Group results show proposed family anchors and each affected member's current family, proposed family and role. The result states that order and Standard stay in place. Layout uses the existing surface tokens and `--stack-gap`; radio groups have separate accessible names per result.

Order remains manual: drag families to reorder. Run-menu selection and queue integration share the stage registry rather than adding a separate control path.

The standalone Preview-only menu control stays disabled until the connected run coordinator supplies that mode. Stored result generation alone does not make that menu option functional. The worker probes its runtime files, Python imports, cached weights and local vision service, then reports availability on polls and during inference. The app server reads those reports; after two missed poll intervals it disables the controls with “Local worker not reporting”.

Results marked as previews show an inspect-only label and no Apply/Accept action. Choosing a normal request later does not convert a stored preview; a new normal run is required.

Research / enrich sits in Run pipeline and has its own persisted model choice and Fill missing / Replace existing option. Suggestions appear in the normal coherent result with source links. The isolated browser proof restored the in-flight row after reload and saved one draft only after explicit Apply; it introduced no separate result screen.
