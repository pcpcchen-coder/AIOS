<!-- bilingual: source=zh-TW -->

> [繁體中文](20_TV_Netflix_Playback_Plan_2026-11.md) | [English](20_TV_Netflix_Playback_Plan_2026-11.en.md)

# 20 Playing a specific Netflix show on the TV: plan (not implemented)

Date: 2026-11-08 (Asia/Taipei). Status: **plan only, not implemented yet**. On 2026-11-08 George asked whether Netflix could play a specific show the way YouTube does, and decided to record it in a document first and build it later.

Earlier batches: [LGTV-1](validation/lgtv-1-2026-11-07.en.md) (TV connection and basic control), [LGTV-2](validation/lgtv-2-2026-11-08.en.md) (playing a specific YouTube video). Today, when you say "play [a series] on Netflix", Nous only opens the Netflix app and says honestly that it cannot play the show directly.

## 1. Breaking down the problem

Playing a specific show has two steps, and Netflix differs from YouTube on both:

| Step | YouTube (LGTV-2) | Netflix |
|---|---|---|
| Send: get a title playing on the TV | `contentTarget`, verified on the real TV by LGTVG3 | A launch parameter circulates in the community; **not published officially and not yet tested on the G3** |
| Find: get a title's ID from its name | The official YouTube Data API | **No official API**; scraping the website violates the terms of use |

## 2. What is known, with sources (checked 2026-11-07)

- **Launch parameter (community method)**: `system.launcher/launch` with `{id: "netflix", contentId: "m=https://www.netflix.com/watch/<titleId>&source_type=4"}`. `titleId` is the number in a Netflix URL (`netflix.com/title/81234567` or `netflix.com/watch/81234567`).
  - The parameter appears only in community discussions, such as issue #25 of lgtv2 and the Home Assistant community forum; neither Netflix nor LG documents it, and `source_type=4` appears only in community examples.
  - LGTVG3's `play_netflix` uses this parameter, but its README says Netflix deep links are "not yet tested on the real TV".
  - It may stop working after a firmware or Netflix app update.
- **Official API**: Netflix's public API has been shut down, and there is no catalogue-lookup or playback API for personal use.
- **Terms**: the Netflix Terms of Use prohibit accessing the Netflix service with robots, spiders, scrapers or other automated means. Opening a title inside the official app is not scraping, but Netflix does not endorse it; scraping the website to map names to IDs is prohibited by the terms.
- **LG deep-link specification**: according to LG's developer forum, this goes through the partner channel (Seller Lounge), and the documents are under NDA, so individual developers cannot get them.

## 3. Possible approaches

| Approach | Description | Pros | Risks and limits |
|---|---|---|---|
| A. Give a URL or ID | The user says "play this on Netflix" and gives a Netflix URL; Nous extracts the `titleId` and sends it | Simple; no lookup needed | The parameter is a community method and needs testing; a URL is hard to say aloud, so this suits pasting from a phone or text |
| B. A personal list | A local file on the Mac maps names to Netflix URLs (for example `<configDir>/netflix-titles.json`); the user says a name, Nous matches it in the list and sends it | Play by name; does not violate the terms (the user builds the list) | New titles must be added first; the launch parameter still needs testing |
| C. Open the search page | Open Netflix → move to the search box with remote keys → type with `com.webos.service.ime/insertText` → stop on the results for the user to pick with the remote | No ID needed; works for any title | Depends on Netflix's screen layout and breaks when it changes; only reaches the results page and cannot confirm playback |

**Recommendation**: build A and B together as one batch (provisionally LGTV-3); decide on C after A has been tested.

## 4. Test at home before starting

From the Mac, send the community parameter to the TV once and check that it really opens the chosen title:

1. Find a title on the Netflix website and note the number in its URL (`titleId`).
2. Try it with LGTVG3's command `lgtv netflix <titleId>`, or wait for a test command from LGTV-3.
3. Record the result:
   - Does it start playing directly, or stop on the title's details page?
   - Does the "Who's watching?" profile screen appear first? Is the title still there after picking a profile?
   - Is there any difference between the number from `netflix.com/title/` and from `netflix.com/watch/`?

The test result decides the approach:
- **It opens that title** (playing or the details page both count): build A + B.
- **It only opens Netflix, not the title**: build neither A nor B, and evaluate C instead.

## 5. Draft design for LGTV-3 (A + B)

- New tool `app.tv.play_netflix`:
  - Takes exactly one of `url` (a Netflix URL) and `title` (a name).
  - With `title`, it matches only against the local list; if the title is not there, it says "this title is not in your list" and does not search the web.
- New tool `app.tv.netflix_list_add` (optional): adds the current name and URL to the list. The list lives only on the Mac and never goes into the repo.
- Readback:
  - It can confirm only that Netflix is in the foreground, not which title is playing, so the best result is `unconfirmed` ("sent, please check the TV").
  - If `com.webos.media/getForegroundAppInfo` also reports `playing` and a media ID for Netflix, use the same readback rules as YouTube. Only a real-TV test will tell.
- If the TV is off, turn it on first; no confirmation card, per George's 2026-11-08 decision.
- Speaking rule: say clearly that Netflix playback is a community method, and ask the user to check the TV when the result is `unconfirmed`.

## 6. Decisions for George (before starting)

1. How to maintain the list: edit the local file by hand, or add titles by voice ("add this to my Netflix list")?
2. If the launch stops on the details page instead of playing, should Nous press OK on the remote once more? Pressing on the wrong screen may do something else, so the recommendation is not to, for now.
3. Should approach C (open the search page) be built?

## 7. Other streaming platforms

Disney+, Prime Video, Apple TV and others also have no public deep links, and there is even less community information than for Netflix. For now they still only open to the app. If they are built later, test at home first, then plan them the same way as this document.

## 8. References

- LGTVG3: <https://github.com/pcpcchen-coder/LGTVG3> (`play_netflix`, not yet verified on the real TV)
- Community methods: <https://github.com/hobbyquaker/lgtv2/issues/25>, <https://community.home-assistant.io/t/has-anyone-figured-out-how-to-automate-playing-something-on-netflix-e-g-on-a-samsung-smart-tv/498399>
- Netflix Terms of Use: <https://help.netflix.com/legal/termsofuse>
- LG developer forum (deep links go through the partner channel): <https://forum.webostv.developer.lge.com/t/how-to-implement-deep-linking-and-add-content-to-lg-webos-tv/24869>
