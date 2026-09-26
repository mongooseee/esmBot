#include <vips/vips8>

#include "common.h"

using namespace std;
using namespace vips;

CmdOutput esmb::Image::Still([[maybe_unused]] const string &type, string &outType, const char *bufferdata,
                             size_t bufferLength, [[maybe_unused]] esmb::ArgumentMap arguments, bool *shouldKill) {
  // no "n" option here, so only the first frame of an animation gets loaded
  VImage in = VImage::new_from_buffer(bufferdata, bufferLength, "", VImage::option()->set("access", "sequential"));

  SetupTimeoutCallback(in, shouldKill);

  // photos (e.g. HEIF from a phone) balloon as PNG, so only use it when there's transparency to keep
  outType = in.has_alpha() ? "png" : "jpg";

  vips::VOption *options = VImage::option()->set("strip", true);
  if (outType == "jpg") options->set("Q", 90);

  char *buf;
  size_t dataSize = 0;
  in.write_to_buffer(("." + outType).c_str(), reinterpret_cast<void **>(&buf), &dataSize, options);

  return {buf, dataSize};
}
