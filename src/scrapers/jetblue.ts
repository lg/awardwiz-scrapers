import { ScraperMetadata } from "../arkalis.js"
import { FlightFare, FlightWithFares, AwardWizQuery, AwardWizScraper } from "../types.js"
import { JetBlueResponse } from "./samples/jetblue.js"
import c from "ansi-colors"

export const meta: ScraperMetadata = {
  name: "jetblue",
  blockUrls: [
    "htp.tokenex.com", "sdk.jetbluevacations.com", "sentry.io", "btstatic.com", "trustarc.com", "asapp.com",
    "thebrighttag.com", "demdex.net", "somnistats.jetblue.com",
    "https://www.jetblue.com/magnoliaauthor/dam/ui-assets/imagery/destinations/large/*"
  ],
  defaultTimeout: 40000
}

export const runScraper: AwardWizScraper = async (arkalis, query) => {
  const url = `https://www.jetblue.com/booking/flights?from=${query.origin}&to=${query.destination}&depart=${query.departureDate}&isMultiCity=false&noOfRoute=1&lang=en&adults=1&children=0&infants=0&sharedMarket=false&roundTripFaresFlag=false&usePoints=true`
  arkalis.goto(url)

  const waitForResult = await arkalis.waitFor({
    "success": { type: "url", url: "https://jbrest.jetblue.com/lfs-rwb/outboundLFS" },
    "prev-day": { type: "html", html: "The dates for your search cannot be in the past." },
  })
  if (waitForResult.name === "prev-day") {
    arkalis.log(c.yellow("WARN: date in past"))
    return []
  }
  if (waitForResult.name !== "success")
    throw new Error(waitForResult.name)
  const fetchFlights = JSON.parse(waitForResult.response?.body) as JetBlueResponse
  if (fetchFlights.error?.code === "JB_RESOURCE_NOT_FOUND") {
    arkalis.log(c.yellow("WARN: No scheduled flights between cities"))
    return []
  } else if (fetchFlights.error) {
    throw new Error(`JetBlue error: ${fetchFlights.error.message}`)
  }

  arkalis.log("parsing results")
  const results = standardizeResults(fetchFlights, query)
  return results
}

const standardizeResults = (raw: JetBlueResponse, query: AwardWizQuery) => {
  const results: FlightWithFares[] = []
  for (const itinerary of raw.itinerary!) {
    if (itinerary.segments.length !== 1)
      continue
    const segment = itinerary.segments[0]!
    const durationText = /\w{2}(?<hours>\d{1,2})H(?<minutes>\d+)M/u.exec(segment.duration)
    if (!durationText || durationText.length !== 3)
      throw new Error("Invalid duration for flight")

    const result: FlightWithFares = {
      departureDateTime: segment.depart.slice(0, 19).replace("T", " "),
      arrivalDateTime: segment.arrive.slice(0, 19).replace("T", " "),
      origin: segment.from,
      destination: segment.to,
      flightNo: `${segment.operatingAirlineCode} ${segment.flightno}`,
      duration: Number.parseInt(durationText.groups!["hours"]!, 10) * 60 + Number.parseInt(durationText.groups!["minutes"]!, 10),
      aircraft: segment.aircraft,
      fares: [],
      amenities: {
        hasPods: segment.aircraft.includes("/Mint"),
        hasWiFi: undefined,
      },
    }

    if (result.origin !== query.origin || result.destination !== query.destination)
      continue

    for (const bundle of itinerary.bundles) {
      if (bundle.status !== "AVAILABLE")
        continue

      const fareToAdd: FlightFare = {
        cabin: {"Y": "economy", "J": "business", "C": "business", "F": "first"}[bundle.cabinclass]!,
        miles: parseInt(bundle.points!),
        cash: parseFloat(bundle.fareTax ?? "0.00"),
        currencyOfCash: "USD",
        scraper: "jetblue",
        bookingClass: bundle.bookingclass,
        isSaverFare: undefined,
      }

      const existingForCabin = result.fares.find((f) => f.cabin === fareToAdd.cabin)
      if (existingForCabin) {
        if (fareToAdd.miles < existingForCabin.miles) {
          result.fares = result.fares.filter((f) => f !== existingForCabin)
          result.fares.push(fareToAdd)
        }
      } else {
        result.fares.push(fareToAdd)
      }
    }

    results.push(result)
  }

  return results
}
