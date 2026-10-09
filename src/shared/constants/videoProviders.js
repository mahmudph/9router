/**
 * Video Provider Configuration
 *
 * Per-provider overrides for the video playground's generic fields in
 * GenericExampleCard. `duration` and `resolution` are not free-form: every
 * upstream accepts a fixed set, and offering a value the provider rejects
 * wastes a billable request. Providers with no entry fall back to the
 * defaults declared in KIND_EXAMPLE_CONFIG.video.extraFields.
 *
 * Keys are `extraFields` keys, so only list a field here when that provider
 * supports a different set than the shared default.
 */
export const VIDEO_PROVIDER_CONFIG = {
  agnes: {
    fieldOptions: {
      // Agnes spells duration `seconds` and accepts 4-12, defaulting to 5.
      // The adapter renames `duration` -> `seconds` on the way upstream.
      duration: ["", "4", "5", "6", "7", "8", "9", "10", "11", "12"],
      aspect_ratio: ["", "16:9", "9:16", "1:1", "21:9", "4:3", "3:4"],
      // The flash tier is locked to 720p; the full 2.5 model goes higher.
      resolution: ["", "720P", "1080P", "1K", "2K"],
    },
    // agnes-video-2.5-flash renders 720p only, so the higher tiers must not be
    // offered for it even though they are valid for agnes-video-2.5.
    modelFieldOptions: {
      "agnes-video-2.5-flash": { resolution: ["", "720P"] },
    },
  },
};
