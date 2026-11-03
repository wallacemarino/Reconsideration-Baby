"use strict";

/*
 * Reconsideration Baby
 * Version 1.10.1
 *
 * Event-driven performance rewrite.
 *
 * Core philosophy:
 * - Improve guest retention, but do not try to trap every departing guest.
 * - Missing an occasional reconsideration opportunity is acceptable.
 *
 * Performance model:
 * - One initial guest census when enabled.
 * - New guests are added incrementally through guest.generation.
 * - No recurring whole-guest census.
 * - Guest registry is cleaned lazily while processing.
 * - Ride/facility cache is rebuilt only after relevant ride actions.
 * - Entertainer cache is rebuilt only after relevant staff actions.
 * - Ride rebuild work is spread across ticks in small slices.
 * - Master OFF means no recurring processing.
 * - A scrollable leaving-guest list is maintained incrementally and can centre the viewport.
 * - Incoming guests remain registered until they enter; only former in-park guests are pruned after leaving.
 * - Known leaving guests are priority-checked every tick; the general registry scans 16 guests per tick.
 * - Need facilities use verified OpenRCT2 numeric ride type IDs.
 * - Suitable rides use Ride.classification === "ride" and fixed-point intensity.
 * - Diagnostic UI records definitive Strongest Need, Suitable Ride and Entertainer flag clears.
 * - Entertainer trigger conditions remain unchanged; only successful activations are logged.
 * - Diagnostic events are numbered and checkbox changes are logged as CONFIG events.
 * - The UI continuously displays the actual internal ON/OFF state for all three triggers.
 * - Matchers contain defensive enabled-state guards so disabled triggers cannot match.
 */

var PLUGIN_NAME = "Reconsideration Baby";
var WINDOW_CLASS = "guest-reconsideration.main";
var STORAGE_PREFIX = "JW.GuestReconsideration.";

var FACILITY_RADIUS = 96;
var RIDE_RADIUS = 96;
var ENTERTAINER_RADIUS = 64;

var FACILITY_RADIUS_SQ = FACILITY_RADIUS * FACILITY_RADIUS;
var RIDE_RADIUS_SQ = RIDE_RADIUS * RIDE_RADIUS;
var ENTERTAINER_RADIUS_SQ = ENTERTAINER_RADIUS * ENTERTAINER_RADIUS;

var NEED_THRESHOLD = 128;

/*
 * OpenRCT2 built-in ride type IDs.
 *
 * Ride.type is a numeric built-in ride type ID in the scripting API.
 * These values match the current OpenRCT2 ride type descriptor order:
 * 28 Food Stall, 30 Drink Stall, 36 Toilets, 48 First Aid.
 */
var RIDE_TYPE_FOOD_STALL = 28;
var RIDE_TYPE_DRINK_STALL = 30;
var RIDE_TYPE_TOILETS = 36;
var RIDE_TYPE_FIRST_AID = 48;

/*
 * Normal guest processing is deliberately light.
 */
var GUESTS_PER_TICK = 16;

/*
 * Cache rebuilds are sliced to avoid doing a complete park scan in one frame.
 */
var RIDES_PER_REBUILD_TICK = 4;

var WINDOW_REFRESH_TICKS = 64;

var settings = {
    enabled: true,
    needs: true,
    rides: true,
    entertainers: true
};

var reconsiderationCount = 0;

var guestRegistry = [];
var guestIds = {};
var guestHasEntered = {};
var guestCursor = 0;

/*
 * Number of registered guests currently inside the park.
 * This is maintained incrementally so the UI does not need a population scan.
 */
var trackedInParkCount = 0;

/*
 * Live, incrementally-maintained view of guests currently flagged as leaving.
 * This is updated as the normal rolling guest scan encounters them, so it adds
 * no whole-park work.
 */
var leavingGuests = [];
var leavingGuestIds = {};
var leavingDisplayGuests = [];

var facilityCache = {
    food_stall: [],
    drink_stall: [],
    toilets: [],
    first_aid: []
};

var rideCache = [];
var entertainerCache = [];

var rideCacheDirty = false;
var entertainerCacheDirty = false;

var rideRebuildActive = false;
var rideRebuildSource = [];
var rideRebuildIndex = 0;

var pendingFacilityCache = null;
var pendingRideCache = null;

var tickCounter = 0;

/*
 * Diagnostic history for definitive testing of all three reconsideration triggers.
 * Entertainer trigger conditions remain unchanged; only successful activations are logged.
 */
var DEBUG_HISTORY_LIMIT = 12;
var debugHistory = [];
var lastDebugTrigger = "None yet";
var debugEventNumber = 0;


/* ------------------------------------------------------------
 * SETTINGS
 * ------------------------------------------------------------ */

function loadSettings() {
    settings.enabled = context.sharedStorage.get(
        STORAGE_PREFIX + "enabled",
        true
    );

    settings.needs = context.sharedStorage.get(
        STORAGE_PREFIX + "needs",
        true
    );

    settings.rides = context.sharedStorage.get(
        STORAGE_PREFIX + "rides",
        true
    );

    settings.entertainers = context.sharedStorage.get(
        STORAGE_PREFIX + "entertainers",
        true
    );
}


function saveSetting(name, value) {
    settings[name] = value;
    context.sharedStorage.set(STORAGE_PREFIX + name, value);
}


/* ------------------------------------------------------------
 * GENERAL HELPERS
 * ------------------------------------------------------------ */

function distanceSquared(a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;

    return dx * dx + dy * dy;
}


function isNear(a, b, radiusSquared) {
    return distanceSquared(a, b) <= radiusSquared;
}


function normaliseRideIntensity(value) {
    if (
        value === undefined ||
        value === null ||
        value < 0
    ) {
        return null;
    }

    /*
     * OpenRCT2 Ride.intensity is documented as a 2-decimal fixed integer:
     * 652 means 6.52. Guest intensity preferences are on the 0..15 scale.
     */
    return value / 100;
}


function getFacilityNeedType(ride) {
    if (ride === undefined || ride === null) {
        return null;
    }

    /*
     * These checks deliberately use OpenRCT2's numeric built-in ride.type.
     * classification is also checked so a malformed/custom object cannot be
     * accidentally treated as a need facility solely because of its type ID.
     */
    if (
        ride.type === RIDE_TYPE_FOOD_STALL &&
        (
            ride.classification === "stall" ||
            ride.classification === "facility"
        )
    ) {
        return "food_stall";
    }

    if (
        ride.type === RIDE_TYPE_DRINK_STALL &&
        (
            ride.classification === "stall" ||
            ride.classification === "facility"
        )
    ) {
        return "drink_stall";
    }

    if (
        ride.type === RIDE_TYPE_TOILETS &&
        (
            ride.classification === "stall" ||
            ride.classification === "facility"
        )
    ) {
        return "toilets";
    }

    if (
        ride.type === RIDE_TYPE_FIRST_AID &&
        (
            ride.classification === "stall" ||
            ride.classification === "facility"
        )
    ) {
        return "first_aid";
    }

    return null;
}


function isActualRide(ride) {
    return (
        ride !== undefined &&
        ride !== null &&
        ride.classification === "ride"
    );
}


function getRidePoints(ride) {
    var result = [];

    if (
        ride === undefined ||
        ride === null ||
        ride.stations === undefined
    ) {
        return result;
    }

    // The native stations getter creates a new array on every access.
    var stations = ride.stations;
    for (var i = 0; i < stations.length; i++) {
        var station = stations[i];

        if (station === undefined || station === null) {
            continue;
        }

        if (
            station.entrance !== undefined &&
            station.entrance !== null
        ) {
            result.push({
                x: station.entrance.x,
                y: station.entrance.y
            });
        }

        if (
            station.start !== undefined &&
            station.start !== null
        ) {
            result.push({
                x: station.start.x,
                y: station.start.y
            });
        }
    }

    return result;
}


/* ------------------------------------------------------------
 * GUEST NEEDS
 * ------------------------------------------------------------ */

function getStrongestNeeds(guest) {
    var foodSeverity = 255 - guest.hunger;
    var drinkSeverity = 255 - guest.thirst;
    var toiletSeverity = guest.toilet;
    var nauseaSeverity = guest.nausea;

    var strongest = foodSeverity;

    if (drinkSeverity > strongest) {
        strongest = drinkSeverity;
    }

    if (toiletSeverity > strongest) {
        strongest = toiletSeverity;
    }

    if (nauseaSeverity > strongest) {
        strongest = nauseaSeverity;
    }

    if (strongest < NEED_THRESHOLD) {
        return [];
    }

    /*
     * If several needs are equally strongest, any matching relief counts.
     * This avoids arbitrary code-order tie breaking, e.g. thirst 255 and
     * toilet 255 should allow either a drink stall or a toilet to trigger.
     */
    var result = [];

    if (foodSeverity === strongest) {
        result.push("food_stall");
    }

    if (drinkSeverity === strongest) {
        result.push("drink_stall");
    }

    if (toiletSeverity === strongest) {
        result.push("toilets");
    }

    if (nauseaSeverity === strongest) {
        result.push("first_aid");
    }

    return result;
}


/* ------------------------------------------------------------
 * GUEST REGISTRY
 * ------------------------------------------------------------ */

function getGuestKey(guest) {
    if (
        guest === undefined ||
        guest === null ||
        guest.id === undefined ||
        guest.id === null
    ) {
        return null;
    }

    return String(guest.id);
}


function registerGuest(guest, assumeAlreadyPresent) {
    if (guest === undefined || guest === null) {
        return;
    }

    var key = getGuestKey(guest);

    if (key !== null) {
        if (guestIds[key]) {
            return;
        }

        guestIds[key] = true;

        /*
         * Guests from the initial census may already be in the park.
         * Newly generated guests start outside and must not be discarded
         * merely because isInPark is false while they approach the entrance.
         */
        if (assumeAlreadyPresent) {
            try {
                guestHasEntered[key] = !!guest.isInPark;

                if (guestHasEntered[key]) {
                    trackedInParkCount++;
                }
            } catch (e) {
                guestHasEntered[key] = false;
            }
        } else {
            guestHasEntered[key] = false;
        }
    }

    guestRegistry.push(guest);
}


/*
 * O(1) removal.
 *
 * Registry order is irrelevant, so instead of splice() shifting potentially
 * thousands of array entries, replace the removed entry with the last guest.
 */
function unregisterGuestAt(index) {
    if (index < 0 || index >= guestRegistry.length) {
        return;
    }

    var removedGuest = guestRegistry[index];
    var removedKey = getGuestKey(removedGuest);

    removeLeavingGuest(removedGuest);

    if (removedKey !== null) {
        if (guestHasEntered[removedKey]) {
            trackedInParkCount--;

            if (trackedInParkCount < 0) {
                trackedInParkCount = 0;
            }
        }

        delete guestHasEntered[removedKey];
        delete guestIds[removedKey];
    }

    var lastIndex = guestRegistry.length - 1;

    if (index !== lastIndex) {
        guestRegistry[index] = guestRegistry[lastIndex];
    }

    guestRegistry.pop();

    if (guestCursor >= guestRegistry.length) {
        guestCursor = 0;
    }
}


function initialiseGuestRegistry() {
    guestRegistry = [];
    guestIds = {};
    guestHasEntered = {};
    guestCursor = 0;
    trackedInParkCount = 0;
    clearLeavingGuests();

    /*
     * Single whole-park census.
     * This seeds guests who already exist when the plugin is enabled.
     */
    var guests = map.getAllEntities("guest");

    for (var i = 0; i < guests.length; i++) {
        registerGuest(guests[i], true);
    }
}


function resolveGeneratedGuest(eventArgs) {
    if (eventArgs === undefined || eventArgs === null) {
        return null;
    }

    /*
     * Be tolerant of API/build differences.
     */
    if (
        eventArgs.guest !== undefined &&
        eventArgs.guest !== null
    ) {
        return eventArgs.guest;
    }

    if (
        eventArgs.entity !== undefined &&
        eventArgs.entity !== null
    ) {
        return eventArgs.entity;
    }

    var id = null;

    if (
        eventArgs.id !== undefined &&
        eventArgs.id !== null
    ) {
        id = eventArgs.id;
    } else if (
        eventArgs.entityId !== undefined &&
        eventArgs.entityId !== null
    ) {
        id = eventArgs.entityId;
    } else if (
        eventArgs.guestId !== undefined &&
        eventArgs.guestId !== null
    ) {
        id = eventArgs.guestId;
    }

    if (
        id !== null &&
        map.getEntity !== undefined
    ) {
        try {
            return map.getEntity(id);
        } catch (e) {
            return null;
        }
    }

    return null;
}



/* ------------------------------------------------------------
 * LEAVING GUEST LIST
 * ------------------------------------------------------------ */

function addLeavingGuest(guest) {
    var key = getGuestKey(guest);

    if (key === null || leavingGuestIds[key]) {
        return;
    }

    leavingGuestIds[key] = true;
    leavingGuests.push(guest);
}


function removeLeavingGuest(guest) {
    var key = getGuestKey(guest);

    if (key === null || !leavingGuestIds[key]) {
        return;
    }

    delete leavingGuestIds[key];

    for (var i = 0; i < leavingGuests.length; i++) {
        if (getGuestKey(leavingGuests[i]) === key) {
            var lastIndex = leavingGuests.length - 1;

            if (i !== lastIndex) {
                leavingGuests[i] = leavingGuests[lastIndex];
            }

            leavingGuests.pop();
            return;
        }
    }
}


function clearLeavingGuests() {
    leavingGuests = [];
    leavingGuestIds = {};
    leavingDisplayGuests = [];
}


function buildLeavingGuestDisplay() {
    var items = [];
    var display = [];

    for (var i = 0; i < leavingGuests.length; i++) {
        var guest = leavingGuests[i];

        try {
            if (
                guest === undefined ||
                guest === null ||
                !guest.isInPark ||
                !guest.getFlag("leavingPark")
            ) {
                continue;
            }

            display.push(guest);

            var name = guest.name;

            if (
                name === undefined ||
                name === null ||
                name === ""
            ) {
                name = "Guest " + guest.id;
            }

            items.push([String(name)]);
        } catch (e) {
            /*
             * Stale references disappear naturally from the display.
             * The rolling guest registry will prune the underlying entry too.
             */
        }
    }

    leavingDisplayGuests = display;

    return items;
}


function centreOnLeavingGuest(row) {
    if (
        typeof ui === "undefined" ||
        row < 0 ||
        row >= leavingDisplayGuests.length
    ) {
        return;
    }

    var guest = leavingDisplayGuests[row];

    try {
        if (
            guest === undefined ||
            guest === null ||
            !guest.isInPark
        ) {
            return;
        }

        ui.mainViewport.scrollTo({
            x: guest.x,
            y: guest.y,
            z: guest.z
        });
    } catch (e) {
        /*
         * Guest may have left between the list refresh and the click.
         */
    }
}


/* ------------------------------------------------------------
 * RIDE / FACILITY CACHE
 * ------------------------------------------------------------ */

function createEmptyFacilityCache() {
    return {
        food_stall: [],
        drink_stall: [],
        toilets: [],
        first_aid: []
    };
}


function startRideCacheRebuild() {
    if (!settings.enabled) {
        return;
    }

    if (!settings.needs && !settings.rides) {
        facilityCache = createEmptyFacilityCache();
        rideCache = [];
        rideCacheDirty = false;
        rideRebuildActive = false;
        return;
    }

    /*
     * Snapshot the comparatively small ride list once, then process only a few
     * entries per tick. This avoids one large JavaScript burst.
     */
    rideRebuildSource = map.rides;
    rideRebuildIndex = 0;

    pendingFacilityCache = createEmptyFacilityCache();
    pendingRideCache = [];

    rideRebuildActive = true;
    rideCacheDirty = false;
}


function processRideForPendingCache(ride) {
    if (ride === undefined || ride === null) {
        return;
    }

    /*
     * Only open attractions/facilities can provide a reconsideration
     * opportunity. Closed/testing/simulating entries are ignored.
     */
    if (ride.status !== "open") {
        return;
    }

    var points = getRidePoints(ride);

    if (points.length === 0) {
        return;
    }

    /*
     * Strongest Need:
     * map OpenRCT2's numeric ride.type IDs into our internal need categories.
     */
    if (settings.needs) {
        var facilityNeedType = getFacilityNeedType(ride);

        if (facilityNeedType !== null) {
            for (var p = 0; p < points.length; p++) {
                pendingFacilityCache[facilityNeedType].push(points[p]);
            }
        }
    }

    /*
     * Suitable Ride:
     * OpenRCT2 provides classification separately from ride.type. Only entries
     * explicitly classified as real rides belong here, never stalls/facilities.
     *
     * Ride.intensity is a two-decimal fixed integer (e.g. 652 == 6.52), while
     * guest minIntensity/maxIntensity are on the 0..15 preference scale.
     */
    if (
        settings.rides &&
        isActualRide(ride)
    ) {
        var intensity = normaliseRideIntensity(ride.intensity);

        if (intensity !== null) {
            pendingRideCache.push({
                name:
                    ride.name !== undefined &&
                    ride.name !== null &&
                    ride.name !== ""
                        ? String(ride.name)
                        : "Ride " + ride.id,
                intensity: intensity,
                points: points
            });
        }
    }
}


function processRideCacheRebuildSlice() {
    if (!rideRebuildActive) {
        return;
    }

    var processed = 0;

    while (
        processed < RIDES_PER_REBUILD_TICK &&
        rideRebuildIndex < rideRebuildSource.length
    ) {
        processRideForPendingCache(
            rideRebuildSource[rideRebuildIndex]
        );

        rideRebuildIndex++;
        processed++;
    }

    if (rideRebuildIndex >= rideRebuildSource.length) {
        /*
         * Atomic swap only after the new cache is complete.
         * Guest processing continues to use the old valid cache during rebuild.
         */
        facilityCache = pendingFacilityCache;
        rideCache = pendingRideCache;

        pendingFacilityCache = null;
        pendingRideCache = null;

        rideRebuildSource = [];
        rideRebuildIndex = 0;
        rideRebuildActive = false;

        /*
         * If another ride action occurred while rebuilding, immediately schedule
         * one more pass. It will still be sliced across ticks.
         */
        if (rideCacheDirty) {
            startRideCacheRebuild();
        }
    }
}


function markRideCacheDirty() {
    if (!settings.enabled) {
        return;
    }

    if (rideRebuildActive) {
        rideCacheDirty = true;
        return;
    }

    rideCacheDirty = true;
}


/* ------------------------------------------------------------
 * ENTERTAINER CACHE
 * ------------------------------------------------------------ */

function rebuildEntertainerCache() {
    entertainerCache = [];
    entertainerCacheDirty = false;

    if (!settings.enabled || !settings.entertainers) {
        return;
    }

    /*
     * Staff populations are normally small.
     * This only runs after enable or a relevant staff action.
     */
    var staff = map.getAllEntities("staff");

    for (var i = 0; i < staff.length; i++) {
        if (staff[i].staffType === "entertainer") {
            entertainerCache.push(staff[i]);
        }
    }
}


function markEntertainerCacheDirty() {
    if (!settings.enabled || !settings.entertainers) {
        return;
    }

    entertainerCacheDirty = true;
}


/* ------------------------------------------------------------
 * RECONSIDERATION TESTS
 * ------------------------------------------------------------ */

function getStrongestNeedMatch(guest) {
    if (!settings.needs) return null;

    var needTypes = getStrongestNeeds(guest);

    if (needTypes.length === 0) {
        return null;
    }

    for (var n = 0; n < needTypes.length; n++) {
        var points = facilityCache[needTypes[n]];

        for (var i = 0; i < points.length; i++) {
            if (
                isNear(
                    guest,
                    points[i],
                    FACILITY_RADIUS_SQ
                )
            ) {
                return {
                    needType: needTypes[n]
                };
            }
        }
    }

    return null;
}


function getSuitableRideMatch(guest) {
    if (!settings.rides) return null;

    for (var i = 0; i < rideCache.length; i++) {
        var cachedRide = rideCache[i];

        if (
            cachedRide.intensity < guest.minIntensity ||
            cachedRide.intensity > guest.maxIntensity
        ) {
            continue;
        }

        for (var p = 0; p < cachedRide.points.length; p++) {
            if (
                isNear(
                    guest,
                    cachedRide.points[p],
                    RIDE_RADIUS_SQ
                )
            ) {
                return cachedRide;
            }
        }
    }

    return null;
}


function guestIsNearEntertainer(guest) {
    if (!settings.entertainers) return false;

    var i = 0;

    while (i < entertainerCache.length) {
        var entertainer = entertainerCache[i];

        try {
            if (
                entertainer === undefined ||
                entertainer === null ||
                entertainer.staffType !== "entertainer"
            ) {
                entertainerCache.splice(i, 1);
                continue;
            }

            if (
                isNear(
                    guest,
                    entertainer,
                    ENTERTAINER_RADIUS_SQ
                )
            ) {
                return true;
            }

            i++;
        } catch (e) {
            entertainerCache.splice(i, 1);
        }
    }

    return false;
}


function persuadeGuestToStay(guest) {
    guest.setFlag("leavingPark", false);
    removeLeavingGuest(guest);
    reconsiderationCount++;
}


function getGuestDisplayName(guest) {
    if (
        guest !== undefined &&
        guest !== null &&
        guest.name !== undefined &&
        guest.name !== null &&
        guest.name !== ""
    ) {
        return String(guest.name);
    }

    if (
        guest !== undefined &&
        guest !== null &&
        guest.id !== undefined
    ) {
        return "Guest " + guest.id;
    }

    return "Unknown guest";
}


function getNeedDisplayName(needType) {
    if (needType === "food_stall") return "hunger";
    if (needType === "drink_stall") return "thirst";
    if (needType === "toilets") return "toilet";
    if (needType === "first_aid") return "nausea";
    return String(needType);
}


function addDebugEvent(text) {
    debugEventNumber++;

    var numberedText =
        "#" +
        debugEventNumber +
        " " +
        text;

    lastDebugTrigger = numberedText;
    debugHistory.unshift([numberedText]);

    if (debugHistory.length > DEBUG_HISTORY_LIMIT) {
        debugHistory.length = DEBUG_HISTORY_LIMIT;
    }
}


function addConfigDebugEvent(name, enabled) {
    addDebugEvent(
        "CONFIG | " +
        name +
        " -> " +
        (enabled ? "ON" : "OFF")
    );
}


function persuadeGuestToStayWithDebug(guest, reasonText) {
    /*
     * Diagnostic wrapper only for Strongest Need and Suitable Ride.
     * The original persuasion function remains unchanged and continues to be
     * used directly by the entertainer trigger.
     */
    var before = false;

    try {
        before = !!guest.getFlag("leavingPark");
    } catch (e) {
        before = false;
    }

    persuadeGuestToStay(guest);

    var after = false;

    try {
        after = !!guest.getFlag("leavingPark");
    } catch (e) {
        after = false;
    }

    addDebugEvent(
        getGuestDisplayName(guest) +
        " | " +
        reasonText +
        " | leaving " +
        String(before) +
        " -> " +
        String(after)
    );
}


/*
 * Returns true if the current registry slot was removed.
 */
function processGuestAt(index) {
    if (index < 0 || index >= guestRegistry.length) {
        return false;
    }

    var guest = guestRegistry[index];

    try {
        if (
            guest === undefined ||
            guest === null
        ) {
            unregisterGuestAt(index);
            return true;
        }

        var key = getGuestKey(guest);
        var inPark = !!guest.isInPark;

        /*
         * Incoming guest lifecycle:
         *
         * A newly-generated guest normally has isInPark == false while walking
         * towards the entrance. Keep them registered. The first time they are
         * observed inside the park, mark them as having entered.
         *
         * Only remove a !isInPark guest if they have previously been observed
         * inside. That distinguishes "approaching the park" from "has left".
         */
        if (inPark) {
            if (
                key !== null &&
                !guestHasEntered[key]
            ) {
                guestHasEntered[key] = true;
                trackedInParkCount++;
            }
        } else {
            if (
                key !== null &&
                guestHasEntered[key]
            ) {
                unregisterGuestAt(index);
                return true;
            }

            /*
             * Still approaching the entrance. Nothing else in this plugin is
             * relevant to them yet.
             */
            removeLeavingGuest(guest);
            return false;
        }

        /*
         * Fast exit for almost the entire park population.
         */
        if (!guest.getFlag("leavingPark")) {
            removeLeavingGuest(guest);
            return false;
        }

        /*
         * Maintain the live UI list as a free by-product of the normal scan.
         */
        addLeavingGuest(guest);

        if (settings.needs) {
            var needMatch = getStrongestNeedMatch(guest);

            if (needMatch !== null) {
                persuadeGuestToStayWithDebug(
                    guest,
                    "NEED: " + getNeedDisplayName(needMatch.needType)
                );
                return false;
            }
        }

        if (settings.rides) {
            var rideMatch = getSuitableRideMatch(guest);

            if (rideMatch !== null) {
                persuadeGuestToStayWithDebug(
                    guest,
                    "RIDE: " +
                    rideMatch.name +
                    " (" +
                    rideMatch.intensity.toFixed(2) +
                    ")"
                );
                return false;
            }
        }

        if (
            settings.entertainers &&
            guestIsNearEntertainer(guest)
        ) {
            persuadeGuestToStayWithDebug(
                guest,
                "ENTERTAINER"
            );
        }

        return false;
    } catch (e) {
        unregisterGuestAt(index);
        return true;
    }
}


function processKnownLeavingGuests() {
    /*
     * Known leaving guests are the high-value population for this plugin.
     * Check every one of them every tick so short encounters with facilities,
     * suitable rides or entertainers are much less likely to be missed.
     *
     * This list is normally tiny compared with the full park population.
     */
    var i = 0;

    while (i < leavingGuests.length) {
        var guest = leavingGuests[i];

        try {
            if (
                guest === undefined ||
                guest === null ||
                !guest.isInPark ||
                !guest.getFlag("leavingPark")
            ) {
                removeLeavingGuest(guest);
                continue;
            }

            if (settings.needs) {
                var needMatch = getStrongestNeedMatch(guest);

                if (needMatch !== null) {
                    persuadeGuestToStayWithDebug(
                        guest,
                        "NEED: " + getNeedDisplayName(needMatch.needType)
                    );
                    continue;
                }
            }

            if (settings.rides) {
                var rideMatch = getSuitableRideMatch(guest);

                if (rideMatch !== null) {
                    persuadeGuestToStayWithDebug(
                        guest,
                        "RIDE: " +
                        rideMatch.name +
                        " (" +
                        rideMatch.intensity.toFixed(2) +
                        ")"
                    );
                    continue;
                }
            }

            if (
                settings.entertainers &&
                guestIsNearEntertainer(guest)
            ) {
                persuadeGuestToStayWithDebug(
                    guest,
                    "ENTERTAINER"
                );
                continue;
            }

            i++;
        } catch (e) {
            removeLeavingGuest(guest);
        }
    }
}


function processGuestBatch() {
    if (
        guestRegistry.length === 0 ||
        (
            !settings.needs &&
            !settings.rides &&
            !settings.entertainers
        )
    ) {
        return;
    }

    var processed = 0;

    while (
        processed < GUESTS_PER_TICK &&
        guestRegistry.length > 0
    ) {
        if (guestCursor >= guestRegistry.length) {
            guestCursor = 0;
        }

        var removed = processGuestAt(guestCursor);

        /*
         * If removed, a different guest was swapped into this same slot.
         */
        if (!removed) {
            guestCursor++;
        }

        processed++;
    }
}


/* ------------------------------------------------------------
 * ACTION EVENT HANDLING
 * ------------------------------------------------------------ */

function getActionName(eventArgs) {
    if (eventArgs === undefined || eventArgs === null) {
        return "";
    }

    /*
     * action is the normal OpenRCT2 GameActionEventArgs field.
     * The fallbacks cost effectively nothing and make the plugin tolerant of
     * differing scripting builds.
     */
    if (
        eventArgs.action !== undefined &&
        eventArgs.action !== null
    ) {
        return String(eventArgs.action);
    }

    if (
        eventArgs.actionName !== undefined &&
        eventArgs.actionName !== null
    ) {
        return String(eventArgs.actionName);
    }

    if (
        eventArgs.name !== undefined &&
        eventArgs.name !== null
    ) {
        return String(eventArgs.name);
    }

    return "";
}


function isRideRelevantAction(action) {
    return (
        action === "ridecreate" ||
        action === "ridedemolish" ||
        action === "rideentranceexitplace" ||
        action === "rideentranceexitremove" ||
        action === "ridesetstatus" ||
        action === "ridesetsetting" ||
        action === "ridefreezerating"
    );
}


function isStaffRelevantAction(action) {
    return (
        action === "staffhire" ||
        action === "stafffire" ||
        action === "staffsetcostume"
    );
}


function handleGameAction(eventArgs) {
    if (!settings.enabled) {
        return;
    }

    var action = getActionName(eventArgs);

    if (isRideRelevantAction(action)) {
        markRideCacheDirty();
    }

    if (isStaffRelevantAction(action)) {
        markEntertainerCacheDirty();
    }
}


/* ------------------------------------------------------------
 * UI
 * ------------------------------------------------------------ */

function updateWindow() {
    if (typeof ui === "undefined") {
        return;
    }

    var window = ui.getWindow(WINDOW_CLASS);

    if (window === undefined || window === null) {
        return;
    }

    var persuadedLabel =
        window.findWidget("persuaded-count");

    var registryLabel =
        window.findWidget("registry-count");

    var leavingLabel =
        window.findWidget("leaving-count");

    var leavingList =
        window.findWidget("leaving-list");

    var debugStateLabel =
        window.findWidget("debug-state");

    var debugLastLabel =
        window.findWidget("debug-last");

    var debugList =
        window.findWidget("debug-list");

    if (
        persuadedLabel !== undefined &&
        persuadedLabel !== null
    ) {
        persuadedLabel.text =
            "Guests persuaded to stay: " + reconsiderationCount;
    }

    if (
        registryLabel !== undefined &&
        registryLabel !== null
    ) {
        registryLabel.text =
            "Guests tracked: " + trackedInParkCount;
    }

    var items = buildLeavingGuestDisplay();

    if (
        leavingLabel !== undefined &&
        leavingLabel !== null
    ) {
        leavingLabel.text =
            "Currently leaving park: " + items.length;
    }

    if (
        leavingList !== undefined &&
        leavingList !== null
    ) {
        leavingList.items = items;
    }

    if (
        debugStateLabel !== undefined &&
        debugStateLabel !== null
    ) {
        debugStateLabel.text =
            "Internal: NEED " +
            (settings.needs ? "ON" : "OFF") +
            " | RIDE " +
            (settings.rides ? "ON" : "OFF") +
            " | ENTERTAINER " +
            (settings.entertainers ? "ON" : "OFF");
    }

    if (
        debugLastLabel !== undefined &&
        debugLastLabel !== null
    ) {
        debugLastLabel.text =
            "Last diagnostic trigger: " + lastDebugTrigger;
    }

    if (
        debugList !== undefined &&
        debugList !== null
    ) {
        debugList.items = debugHistory;
    }
}

function clearCaches() {
    facilityCache = createEmptyFacilityCache();
    rideCache = [];
    entertainerCache = [];

    pendingFacilityCache = null;
    pendingRideCache = null;

    rideRebuildSource = [];
    rideRebuildIndex = 0;

    rideCacheDirty = false;
    entertainerCacheDirty = false;
    rideRebuildActive = false;
}


function enablePlugin() {
    initialiseGuestRegistry();

    /*
     * Initial build is also sliced.
     */
    clearCaches();
    rideCacheDirty = true;

    if (settings.entertainers) {
        rebuildEntertainerCache();
    }
}


function disablePlugin() {
    guestRegistry = [];
    guestIds = {};
    guestHasEntered = {};
    guestCursor = 0;
    trackedInParkCount = 0;
    clearLeavingGuests();

    clearCaches();
}


function setEnabled(value) {
    saveSetting("enabled", value);

    if (value) {
        enablePlugin();
    } else {
        disablePlugin();
    }

    updateWindow();
}


function openWindow() {
    if (typeof ui === "undefined") {
        return;
    }

    var existing = ui.getWindow(WINDOW_CLASS);

    if (existing !== undefined && existing !== null) {
        existing.bringToFront();
        return;
    }

    var initialLeavingItems = buildLeavingGuestDisplay();

    ui.openWindow({
        classification: WINDOW_CLASS,
        title: PLUGIN_NAME,
        width: 320,
        height: 448,
        minWidth: 320,
        minHeight: 378,
        maxWidth: 520,
        maxHeight: 738,
        colours: [7, 7],
        widgets: [
            {
                type: "checkbox",
                name: "enabled",
                x: 10,
                y: 22,
                width: 295,
                height: 14,
                text: "Enable Reconsideration Baby",
                isChecked: settings.enabled,
                onChange: function (checked) {
                    setEnabled(checked);
                }
            },
            {
                type: "groupbox",
                x: 5,
                y: 41,
                width: 310,
                height: 78,
                text: "Reasons to reconsider"
            },
            {
                type: "checkbox",
                name: "needs",
                x: 15,
                y: 57,
                width: 285,
                height: 14,
                text: "Strongest need has relief nearby",
                isChecked: settings.needs,
                tooltip:
                    "Food, drink, toilet or first aid within about 3 tiles",
                onChange: function (checked) {
                    saveSetting("needs", checked);
                    addConfigDebugEvent("NEED", checked);

                    if (settings.enabled) {
                        markRideCacheDirty();
                    }

                    updateWindow();
                }
            },
            {
                type: "checkbox",
                name: "rides",
                x: 15,
                y: 78,
                width: 285,
                height: 14,
                text: "Suitable ride encountered",
                isChecked: settings.rides,
                tooltip:
                    "Open ride within about 3 tiles and inside the guest's preferred intensity range",
                onChange: function (checked) {
                    saveSetting("rides", checked);
                    addConfigDebugEvent("RIDE", checked);

                    if (settings.enabled) {
                        markRideCacheDirty();
                    }

                    updateWindow();
                }
            },
            {
                type: "checkbox",
                name: "entertainers",
                x: 15,
                y: 99,
                width: 285,
                height: 14,
                text: "Entertainer encountered",
                isChecked: settings.entertainers,
                tooltip:
                    "Entertainer within about 2 tiles",
                onChange: function (checked) {
                    saveSetting("entertainers", checked);
                    addConfigDebugEvent("ENTERTAINER", checked);

                    if (settings.enabled && checked) {
                        rebuildEntertainerCache();
                    } else {
                        entertainerCache = [];
                    }

                    updateWindow();
                }
            },
            {
                type: "label",
                name: "persuaded-count",
                x: 10,
                y: 128,
                width: 300,
                height: 14,
                text:
                    "Guests persuaded to stay: " + reconsiderationCount
            },
            {
                type: "label",
                name: "registry-count",
                x: 10,
                y: 145,
                width: 300,
                height: 14,
                text:
                    "Guests tracked: " + trackedInParkCount
            },
            {
                type: "label",
                name: "debug-state",
                x: 10,
                y: 166,
                width: 300,
                height: 14,
                text:
                    "Internal: NEED " +
                    (settings.needs ? "ON" : "OFF") +
                    " | RIDE " +
                    (settings.rides ? "ON" : "OFF") +
                    " | ENTERTAINER " +
                    (settings.entertainers ? "ON" : "OFF"),
                tooltip:
                    "Live internal trigger state used by Reconsideration Baby."
            },
            {
                type: "label",
                name: "debug-last",
                x: 10,
                y: 184,
                width: 300,
                height: 14,
                text:
                    "Last diagnostic trigger: " + lastDebugTrigger,
                tooltip:
                    "Shows successful Strongest Need, Suitable Ride and Entertainer reconsiderations."
            },
            {
                type: "listview",
                name: "debug-list",
                x: 10,
                y: 202,
                width: 300,
                height: 82,
                isStriped: true,
                canSelect: false,
                showColumnHeaders: false,
                columns: [
                    {
                        header: "Recent diagnostic triggers",
                        width: 285
                    }
                ],
                items: debugHistory
            },
            {
                type: "label",
                name: "leaving-count",
                x: 10,
                y: 292,
                width: 300,
                height: 14,
                text:
                    "Currently leaving park: " + initialLeavingItems.length
            },
            {
                type: "listview",
                name: "leaving-list",
                x: 10,
                y: 310,
                width: 300,
                height: 128,
                isStriped: true,
                canSelect: true,
                showColumnHeaders: false,
                columns: [
                    {
                        header: "Guest",
                        width: 285
                    }
                ],
                items: initialLeavingItems,
                onClick: function (row, column) {
                    centreOnLeavingGuest(row);
                }
            }
        ],
        onUpdate: function () {
            /*
             * Keep the list using the available vertical space if the player
             * resizes the window.
             */
            var window = ui.getWindow(WINDOW_CLASS);

            if (window === undefined || window === null) {
                return;
            }

            var list = window.findWidget("leaving-list");
            var debugList = window.findWidget("debug-list");

            if (debugList !== undefined && debugList !== null) {
                debugList.width = window.width - 20;
            }

            if (list !== undefined && list !== null) {
                list.width = window.width - 20;
                list.height = window.height - 321;
            }
        }
    });
}

/* ------------------------------------------------------------
 * MAIN
 * ------------------------------------------------------------ */

function main() {
    loadSettings();

    if (typeof ui !== "undefined") {
        ui.registerMenuItem(
            PLUGIN_NAME,
            function () {
                openWindow();
            }
        );
    }

    if (settings.enabled) {
        enablePlugin();
    }

    /*
     * Incremental guest additions.
     */
    context.subscribe(
        "guest.generation",
        function (e) {
            if (!settings.enabled) {
                return;
            }

            var guest = resolveGeneratedGuest(e);

            if (guest !== null) {
                registerGuest(guest, false);
            }
        }
    );

    /*
     * Event-driven infrastructure invalidation.
     * No interval.day cache rebuild exists in v1.4.
     */
    context.subscribe(
        "action.execute",
        function (e) {
            handleGameAction(e);
        }
    );

    context.subscribe(
        "interval.tick",
        function () {
            if (!settings.enabled) {
                return;
            }

            tickCounter++;

            /*
             * Dirty ride cache begins rebuilding on the next normal tick.
             * Rebuild then advances only a few rides per tick.
             */
            if (
                rideCacheDirty &&
                !rideRebuildActive
            ) {
                startRideCacheRebuild();
            }

            processRideCacheRebuildSlice();

            /*
             * Staff refresh is only performed after a relevant action.
             * Staff lists are small, so a sliced rebuild is unnecessary here.
             */
            if (entertainerCacheDirty) {
                rebuildEntertainerCache();
            }

            processKnownLeavingGuests();
            processGuestBatch();

            if (
                tickCounter % WINDOW_REFRESH_TICKS === 0
            ) {
                updateWindow();
            }

            if (tickCounter > 100000000) {
                tickCounter = 0;
            }
        }
    );
}


registerPlugin({
    name: PLUGIN_NAME,
    version: "1.10.1",
    authors: ["James / OpenAI"],
    type: "local",
    main: main,
    licence: "MIT",
    targetApiVersion: 83
});
