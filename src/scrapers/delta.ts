// This scraper currently gets detected after the 3rd attempt unless a proxy is used.

import { ScraperMetadata } from "../arkalis.js"
import { AwardWizQuery, AwardWizScraper, FlightFare, FlightWithFares } from "../types.js"
import { DeltaResponse } from "./samples/delta.js"
import dayjs from "dayjs"
import c from "ansi-colors"

export const meta: ScraperMetadata = {
  name: "delta",
  blockUrls: [
    "yahoo.com", "google.com", "facebook.com", "facebook.net", "pinterest.com", "bing.com", "t.co", "twitter.com",
    "doubleclick.net", "adservice.google.com", "trackjs.com", "quantummetric.com", "foresee.com",
    "dynatrace-managed.com", "demdex.net", "criteo.com", "go-mpulse.net", "flashtalking.com",

    // risky
    "deltaairlines.tt.omtrdc.net", "tms.delta.com", "smetrics.delta.com"
  ]
}

export const runScraper: AwardWizScraper = async (arkalis, query) => {
  // Auto fill in the origin/destination when it comes up
  await arkalis.interceptRequest("https://www.delta.com/prefill/retrieveSearch?searchType=RecentSearchesJSON*", () => {
    return {
      action: "fulfill",
      responseCode: 200,
      dataObj: [{
        "airports": {
          "fromCity": `${query.origin}`,
          "toCity": `${query.destination}`,
          "fromAirportcode": `${query.origin}`,
          "toAirportcode": `${query.destination}`,
          "fromStateCode": "",
          "toStateCode": ""
        },
        "selectTripType": "ONE_WAY",
        "dates": { "departureDate": dayjs(query.departureDate).format("MM/DD/YYYY"), "returnDate": "" },
        "passenger": "1", "swapedFromCity": "null", "swapedToCity": "null", "schedulePrice": { "value": "miles" },
        "faresFor": "BE", "meetingEventCode": "", "refundableFlightsOnly": false, "nearbyAirports": false,
        "deltaOnly": "off", "awardTravel": true, "departureTime": "AT", "returnTime": "AT", "infantCount": 0,
        "adtCount": 0, "cnnCount": 0, "gbeCount": 0,
      }]
    }
  })

  arkalis.goto("https://www.delta.com/flight-search/book-a-flight")
  await arkalis.waitFor({ "success": { type: "url", url: "https://www.delta.com/prefill/retrieveSearch?searchType=RecentSearchesJSON*", statusCode: 200 }})
  await arkalis.clickSelector("#chkFlexDate")
  void arkalis.clickSelector("#btnSubmit")   // async

  let waitForResult = await arkalis.waitFor({
    "success": { type: "url", url: "https://www.delta.com/shop/ow/search", statusCode: 200 },
    "system unavailable anti-botting": { type: "url", url: "https://www.delta.com/content/www/en_US/system-unavailable1.html" },
    "continue button": { type: "url", url: "https://www.delta.com/shop/ow/flexdatesearch" },
  })
  if (waitForResult.name === "continue button") {
    arkalis.log("interstitial page with continue button appeared, clicking it")
    await arkalis.clickSelector("#btnContinue")
    waitForResult = await arkalis.waitFor({
      "success": { type: "url", url: "https://www.delta.com/shop/ow/search", statusCode: 200 },
    })
  }
  if (waitForResult.name !== "success")
    throw new Error(waitForResult.name)
  const searchResults = JSON.parse(waitForResult.response?.body) as DeltaResponse

  if (searchResults.shoppingError?.error?.message) {
    if (searchResults.shoppingError.error.message.message.includes("There are no scheduled Delta/Partner flights")) {
      arkalis.log(c.yellow("WARN: No scheduled flights between cities"))
      return []
    }
    throw new Error(searchResults.shoppingError.error.message.message)
  }

  arkalis.log("finished getting results, parsing")
  const flightsWithFares: FlightWithFares[] = []
  if (searchResults.itinerary.length > 0) {
    const flights = standardizeResults(searchResults, query)
    flightsWithFares.push(...flights)
  }

  return flightsWithFares
}

// eslint-disable-next-line no-unused-vars
const standardizeResults = (raw: DeltaResponse, query: AwardWizQuery) => {
  const results: FlightWithFares[] = []
  for (const itinerary of raw.itinerary) {
    const trip = itinerary.trip[0]!
    const segment = trip.flightSegment[0]!

    if (!dayjs(trip.schedDepartLocalTs.replace("T", " ")).isSame(dayjs(query.departureDate), "day"))
      continue

    const result: FlightWithFares = {
      departureDateTime: trip.schedDepartLocalTs.replace("T", " "),
      arrivalDateTime: trip.schedArrivalLocalTs.replace("T", " "),
      origin: trip.originAirportCode,
      destination: trip.destAirportCode,
      flightNo: `${segment.marketingCarrier.code} ${segment.marketingFlightNum}`,
      duration: segment.totalAirTime.day * 24 * 60 + segment.totalAirTime.hour * 60 + segment.totalAirTime.minute,
      aircraft: segment.flightLeg[0]?.aircraft.fleetName,
      fares: trip.viewSeatUrls[0]!.fareOffer.itineraryOfferList
        .filter((offer) => !offer.soldOut && offer.offered)
        .map((offer) => ({
          cash: offer.totalPrice?.currency?.amount ?? -1,
          currencyOfCash: offer.totalPrice?.currency?.code ?? "USD",
          miles: offer.totalPrice?.miles?.miles ?? 0,
          cabin: offer.brandInfoByFlightLegs[0]!.cos[0] === "O" ? "business" : "economy",
          scraper: "delta",
          bookingClass: offer.brandInfoByFlightLegs[0]!.cos
        }))
        .filter((fare) => fare.cash !== -1 && fare.miles !== 0)
        .reduce<FlightFare[]>((bestForCabin, fare) => {
          const existing = bestForCabin.find((check) => check.cabin === fare.cabin)
          if (existing && existing.miles < fare.miles)
            return bestForCabin
          return [...bestForCabin.filter((check) => check.cabin !== fare.cabin), fare]
        }, []),
      amenities: {
        hasPods: trip.summarizedProducts.some((product) => product.productIconId === "fla") || (segment.marketingCarrier.code === "DL" ? false : undefined),
        hasWiFi: trip.summarizedProducts.some((product) => product.productIconId === "wif") || (segment.marketingCarrier.code === "DL" ? false : undefined),
      }
    }

    if (trip.flightSegment.length > 1)
      continue
    if (trip.originAirportCode !== raw.tripOriginAirportCode || trip.destAirportCode !== raw.tripDestinationAirportCode)
      continue

    results.push(result)
  }

  return results
}
