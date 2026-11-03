const { existsSync } = require("node:fs");
const { join } = require("node:path");

// Android notifications come through Firebase Cloud Messaging, which needs the Firebase file of the
// app. The file is optional, so the app builds before the Firebase project exists, and such a build
// gets no notifications on Android. The file has public identifiers only; the account service has the
// key that sends.
const GOOGLE_SERVICES_FILE = "./google-services.json";
const LOCAL_TERMUX_BUILD = process.env.OPENBOT_LOCAL_TERMUX_BUILD === "1";

/** @param {{ config: import('expo/config').ExpoConfig }} context */
module.exports = ({ config }) => {
  const withGoogleServices = { ...config, android: { ...config.android } };
  if (LOCAL_TERMUX_BUILD) delete withGoogleServices.android.googleServicesFile;
  else if (existsSync(join(__dirname, GOOGLE_SERVICES_FILE)))
    withGoogleServices.android.googleServicesFile = GOOGLE_SERVICES_FILE;
  if (!LOCAL_TERMUX_BUILD) return withGoogleServices;
  const localConfig = { ...withGoogleServices };
  delete localConfig.owner;
  delete localConfig.updates;
  localConfig.extra = { ...localConfig.extra };
  delete localConfig.extra.eas;
  localConfig.extra.eas = { projectId: "4d18bded-8522-4ccd-9eac-e8398f54aff3" };
  return {
    ...localConfig,
    name: "OpenBot Local",
    slug: "openbot-local-termux",
    scheme: "openbot-local-termux",
    android: { ...withGoogleServices.android, package: "run.openbot.mobile.termux" },
  };
};
