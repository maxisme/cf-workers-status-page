import config from '../../config.yaml'

import {
  downtimeString,
  getCheckLocation,
  getDate,
  getKVMonitors,
  notifyDiscord,
  notifyNotifi,
  notifySlack,
  notifyTelegram,
  setKVMonitors,
} from './helpers'

export async function processCronTrigger(event) {
  // Get Worker PoP and save it to monitorsStateMetadata
  const checkLocation = await getCheckLocation()
  const checkDay = getDate()

  // Get monitors state from KV
  let monitorsState = await getKVMonitors()

  // Create empty state objects if not exists in KV storage yet
  if (!monitorsState) {
    monitorsState = { lastUpdate: {}, monitors: {} }
  }

  // Reset default all monitors state to true
  monitorsState.lastUpdate.allOperational = true

  for (const monitor of config.monitors) {
    // Create default monitor state if does not exist yet
    if (typeof monitorsState.monitors[monitor.id] === 'undefined') {
      monitorsState.monitors[monitor.id] = {
        firstCheck: checkDay,
        lastCheck: {},
        checks: {},
        currentFails: 0,
      }
    }

    console.log(`Checking ${monitor.name} ...`)

    // Fetch the monitors URL
    const init = {
      method: monitor.method || 'GET',
      redirect: monitor.followRedirect ? 'follow' : 'manual',
      headers: {
        'User-Agent': config.settings.user_agent || 'cf-worker-status-page',
        'Cache-Control': 'no-cache',
      },
      cf: {
        cacheTtl: 0,
      },
    }

    // Perform a check and measure time
    const requestStartTime = Date.now()
    const checkResponse = await fetch(monitor.url, init)
    const requestTime = Math.round(Date.now() - requestStartTime)

    // Determine whether operational and status changed
    const monitorOperational =
      checkResponse.status === (monitor.expectStatus || 200)

    const monitorChange =
      monitorsState.monitors[monitor.id].lastCheck.operational !==
      monitorOperational

    // Save monitor's last check response status
    monitorsState.monitors[monitor.id].lastCheck = {
      status: checkResponse.status,
      statusText: checkResponse.statusText,
      operational: monitorOperational,
    }

    // make sure checkDay exists in checks in cases when needed
    if (
      (config.settings.collectResponseTimes || !monitorOperational) &&
      !monitorsState.monitors[monitor.id].checks.hasOwnProperty(checkDay)
    ) {
      monitorsState.monitors[monitor.id].checks[checkDay] = {
        fails: 0,
        res: {},
      }
    }

    // Send Slack message on monitor change
    if (
      shouldAlert &&
      typeof SECRET_SLACK_WEBHOOK_URL !== 'undefined' &&
      SECRET_SLACK_WEBHOOK_URL !== 'default-gh-action-secret'
    ) {
      event.waitUntil(notifySlack(monitor, monitorOperational))
    }

    const currentFails = monitorsState.monitors[monitor.id].currentFails
    const reminderCountNow =
      currentFails % config.settings.reminderMinuteInterval === 0
    const reminderCountLimit =
      Math.floor(currentFails / config.settings.reminderMinuteInterval) <=
      config.settings.reminderCount

    let shouldAlert =
      monitorChange ||
      (reminderCountNow && reminderCountLimit && !monitorOperational)

    // Send Telegram message on monitor change
    if (
      shouldAlert &&
      typeof SECRET_TELEGRAM_API_TOKEN !== 'undefined' &&
      SECRET_TELEGRAM_API_TOKEN !== 'default-gh-action-secret' &&
      typeof SECRET_TELEGRAM_CHAT_ID !== 'undefined' &&
      SECRET_TELEGRAM_CHAT_ID !== 'default-gh-action-secret'
    ) {
      event.waitUntil(notifyTelegram(monitor, monitorOperational))
    }

    // Send Discord message on monitor change
    if (
      shouldAlert &&
      typeof SECRET_DISCORD_WEBHOOK_URL !== 'undefined' &&
      SECRET_DISCORD_WEBHOOK_URL !== 'default-gh-action-secret'
    ) {
      event.waitUntil(notifyDiscord(monitor, monitorOperational))
    }

    // Send notifi message on monitor change
    if (
      shouldAlert &&
      typeof SECRET_NOTIFI_CREDENTIALS !== 'undefined' &&
      SECRET_NOTIFI_CREDENTIALS !== 'default-gh-action-secret'
    ) {
      event.waitUntil(
        notifyNotifi(
          monitor,
          monitorOperational,
          downtimeString(currentFails + 1),
        ),
      )
    }

    if (config.settings.collectResponseTimes && monitorOperational) {
      // make sure location exists in current checkDay
      if (
        !monitorsState.monitors[monitor.id].checks[checkDay].res.hasOwnProperty(
          checkLocation,
        )
      ) {
        monitorsState.monitors[monitor.id].checks[checkDay].res[checkLocation] =
          {
            n: 0,
            ms: 0,
            a: 0,
          }
      }

      // increment number of checks and sum of ms
      const no = ++monitorsState.monitors[monitor.id].checks[checkDay].res[
        checkLocation
      ].n
      const ms = (monitorsState.monitors[monitor.id].checks[checkDay].res[
        checkLocation
      ].ms += requestTime)

      // save new average ms
      monitorsState.monitors[monitor.id].checks[checkDay].res[checkLocation].a =
        Math.round(ms / no)

      monitorsState.monitors[monitor.id].currentFails = 0
    } else if (!monitorOperational) {
      // Save allOperational to false
      monitorsState.lastUpdate.allOperational = false

      monitorsState.monitors[monitor.id].checks[checkDay].fails++
      monitorsState.monitors[monitor.id].currentFails++
    }
  }

  // Save last update information
  monitorsState.lastUpdate.time = Date.now()
  monitorsState.lastUpdate.loc = checkLocation

  // Save monitorsState to KV storage
  await setKVMonitors(monitorsState)

  return new Response('OK')
}
