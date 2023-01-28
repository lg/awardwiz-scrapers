import c from "ansi-colors"
import { logger, logGlobal } from "./log.js"
import { createClient } from "@redis/client"
import { chromium } from "playwright-extra"
import { DebugOptions, Scraper } from "./scraper.js"
import { AwardWizQuery, AwardWizScraperModule } from "./types.js"

const debugOptions: DebugOptions = {
  showBrowserDebug: true,
  maxAttempts: 5,
  minBrowserPool: 1,
  maxBrowserPool: 1,

  showBlocked: false,
  showFullRequest: [],
  showFullResponse: [],
  useProxy: true,

  showUncached: true,
  pauseAfterRun: false,
  pauseAfterError: true,

  tracingPath: "./tmp/traces",
}

const browser = new Scraper(chromium, debugOptions)
await browser.create()

const scraper: AwardWizScraperModule = await import(`./scrapers/${process.argv[2]}.js`)
const query: AwardWizQuery = { origin: process.argv[3]!, destination: process.argv[4]!, departureDate: process.argv[5]! }

const result = await browser.runAttempt(async (sc) => {
  sc.log("Using query:", query)
  const scraperResults = await scraper.runScraper(sc, query).catch(async (e) => {
    sc.log(c.red("Error in scraper"), e)
    sc.context?.setDefaultTimeout(0)
    await sc.pause()
    return []
  })
  sc.log(c.green(`Completed with ${scraperResults.length} results`), sc.stats?.toString())
  return scraperResults
}, scraper.meta, `debug-${Math.random().toString(36).substring(2, 8)}`)

logGlobal(result)

logGlobal("Ending")
await browser.destroy()

const redis = createClient({ url: process.env["REDIS_URL"] })
await redis.connect()
await redis.save()
await redis.disconnect()
logGlobal("Ended")

logger.close()