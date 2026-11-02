# Fresh independent UI release review — initial
INDEPENDENCE: FRESH
Subject: PR11 670efce8a8e74b465959d0279be4422d99e6fb23 against b5a18561f8316ad83a2cfb09150fe7b3fb6b35ce.
Verdict: NOT_READY pending F01 refusal repair and R-UI-01.

## Independent reproduction
7 own Chromium browser cases PASS on unchanged exactUIhead with realistic34-character unbroken title: themes light/dark at320/390/1440; keyboard focus outline; rating native-dialog Escape; reveal50 stored successors without extra API; immediate pause freeze and actual requested/accepted/observed classes; one-song bounded projection disables actual rating/skip and cannotchain; offline disables transport with savedqueue recovery; route-change accepted play confirms onlynewactualobservation; guest/native pause isolated fromcachedSpotify; desktopSenderwall materializes/clicks afterscroll withoutqueue mutation.
These are intercepted synthetic API renderchecks, notliveSpotify orphysicaliPhone acceptance. Probe /tmp/ts-ui-independent/e2e/independent-release.spec.ts, log /tmp/ui-independent-normal-browser.log.

## R-UI-01 P2 blocking — verylong unbroken song metadata expands desktopgrid
Samefirstcase with name="ExtremelyLongUnbrokenSongTitle".repeat(5) (140characters), width1440 results document.scrollWidth-innerWidth=3861. H2/artist/album become4952.94px wide. Mobile320/390 passes. New .now-copy display:grid has implicit auto track and h2 overflow-wrap:break-word; baseline used anywhere. Require narrowCSS fix preservingfulltext and regression across320/390/1440/themes withlong unbroken andspacedtitles. Evidence /tmp/ui-independent-browser.log, /tmp/ui-review-overflow.png, initialprobe /tmp/ui-independent-initial-probe.ts.34-character wordpasses; this is boundarycase, notordinaryshorttitlefailure.

## Existing audit triage
F01 serious saved-active-session/errorloss confirmed source; root separatelyfixing and needsactualfinalfreshreview.
F02 oneearlyproviderconfirmation lag andF04 DOserialqueue priority are pre-existing operationalrisks: useful followup deterministic lag/slowDOtests, noUIintroduced scheduler regression. F03 properconfirmed429operationhold plus vague"gleich" wording pre-existing, user-facing copy improvement warranted, noinventedglobalgate. F05 projectionrepeat/externalqueue caveat existing source withexplicitestimatedlabel/no durablewrites;49successors duringprojection is expectedcurrent51contract. F06 late naturalnext journalconfirmation is savedprovider-evidence transition, old timingrisk, notUIregression. F07 explicitID persists intentionally andactualattempt/no silentredirect preserved. F08 lackunitstoretests alone is notblocker withactual browserfunctionalassertions intact. None requires speculative broadbackendrefactor as prerequisite toUIrelease.

## Source/craft checks
Protected src/core,src/shared,src/worker,store,playback-view,progress,api,router unchanged byPR. Handlers keep nativecapabilities, deviceexplicit routing, expectedsession/entry, ratingguards, offlinedisables andsavedqueue/newqueueconfirmation.2 changed E2Estrings describe accepted phasecorrectly anddo notweaken behavioral assertions.
Impeccable detector ran oncebutdegradedregexmode (parser dependenciesabsent); no claimcompletecontrast/a11yscan. Designsidecarstale advisory is nonblocking documentationdrift. Sourcecolorpairs andfocus/reducedmotion/nativecontrol semanticschecked manually. No fullWCAG certification claimed.
PhysicaliPhonewake/latency,liveSpotify429/propagation,ownerHA/MA,populatedproductionrestore NOT_RUN. PriorCodexbot commentary andClaude auditcounts notaccepted as independent reproduction.
