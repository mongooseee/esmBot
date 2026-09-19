#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <vips/vips8>

#include "common.h"

void LoadFonts(string basePath) {
  // manually loading fonts to workaround some font issues with libvips
  if (!FcConfigAppFontAddDir(NULL, (const FcChar8 *)(basePath + "assets/fonts/").c_str())) {
    std::cerr << "Unable to load local font files from directory, falling back to "
                 "global fonts (which may be inaccurate!)"
              << std::endl;
  }
  if (!FcConfigParseAndLoad(FcConfigGetCurrent(), (const FcChar8 *)(basePath + "assets/fonts/fontconfig.xml").c_str(),
                            true)) {
    std::cerr << "Unable to load local fontconfig, some fonts may be inaccurate!" << std::endl;
  }
}

void CheckPixelLimit(const char *bufferData, size_t bufferLength) {
  // this only parses the header, vips is lazy
  vips::VImage probe = vips::VImage::new_from_buffer(bufferData, bufferLength, "");

  if ((int64_t)probe.width() * probe.height() > MAX_PIXELS) {
    throw std::runtime_error("image_pixel_limit");
  }
}

vips::VImage NormalizeVips(vips::VImage in, int *width, int *pageHeight, int nPages) {
  if (nPages > 1000) {
    throw -1;
  }

  vips::VImage out = in;

  double maxSize = std::max(*width, *pageHeight);
  if (maxSize > 800) {
    out = out.resize(800 / maxSize);
    *width = out.width();
    int newHeight = vips_image_get_page_height(out.get_image());
    *pageHeight = nPages > 1 ? newHeight / nPages : newHeight;
  }

  return out;
}

vips::VOption *GetInputOptions(string type, bool sequential, bool sequentialIfAnim) {
  bool anim = type == "gif" || type == "webp";
  vips::VOption *options = vips::VImage::option();

  if (anim) {
    options->set("n", -1);
    if (sequential && sequentialIfAnim) {
      options->set("access", "sequential");
    }
  }

  if (sequential && !sequentialIfAnim) {
    options->set("access", "sequential");
  }

  return options;
}

static int GetQuality(esmb::ArgumentMap arguments) {
  int quality = GetArgumentWithFallback<int>(arguments, "quality", DEFAULT_QUALITY);
  return std::clamp(quality, 1, 100);
}

vips::VOption *GetOutputOptions(const string &outType, esmb::ArgumentMap arguments, int dither, bool reoptimise) {
  // GIF is the only palette based format we write, so it takes dithering options
  // instead of the quality factor every other format understands
  if (outType == "gif") {
    vips::VOption *options = vips::VImage::option()->set("dither", dither);
    if (reoptimise) options->set("reoptimise", 1);
    return options;
  }

  return vips::VImage::option()->set("Q", GetQuality(arguments));
}

static void TimeoutCallback(VipsImage *image, [[maybe_unused]] VipsProgress *progress, CallbackData *data) {
  time_t now = time(0);
  bool *shouldKill = data->shouldKill;

  if (now > data->expiration || (shouldKill != NULL && *shouldKill)) {
    if (shouldKill != NULL) *shouldKill = true;
    vips_image_set_kill(image, true);
  }
}

void SetupTimeoutCallback(vips::VImage image, bool *shouldKill) {
  VipsImage *img = image.get_image();
  CallbackData *cbData = VIPS_NEW(img, CallbackData);
  cbData->expiration = time(0) + IMG_TIMEOUT;
  cbData->shouldKill = shouldKill;
  g_signal_connect(img, "eval", G_CALLBACK(TimeoutCallback), cbData);
  vips_image_set_progress(img, true);
}
