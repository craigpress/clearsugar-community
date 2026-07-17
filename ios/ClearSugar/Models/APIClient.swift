import Foundation
import Security

// MARK: - API Client

actor APIClient {
    static let shared = APIClient()

    private let session: URLSession
    private let maxRetries = 3

    /// API key -- stored in memory, loaded from Keychain on init
    private var apiKey: String
    /// Bearer JWT from username/password login
    private var bearerToken: String

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 30
        self.session = URLSession(configuration: config)

        // Load auth from Keychain: prefer Bearer JWT, fall back to API key
        self.bearerToken = AuthManager.loadFromKeychain(service: AppConfig.jwtKeychainService) ?? ""
        self.apiKey = Self.loadKeyFromKeychain() ?? ""
    }

    /// Resolved server base URL (SetupView runtime value wins over the baked-in one)
    private var baseURL: URL {
        get throws {
            guard let url = AppConfig.serverURL else {
                throw APIError.notConfigured
            }
            return url
        }
    }

    /// Apply the best available auth to a request
    private func applyAuth(to request: inout URLRequest) {
        if !bearerToken.isEmpty {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        } else if !apiKey.isEmpty {
            request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
        }
    }

    // MARK: - Retry

    /// Retry transient failures (HTTP 429/5xx, invalid responses, and network
    /// blips like timeouts or dropped connections) with exponential backoff.
    private func withRetry<T>(_ operation: () async throws -> T) async throws -> T {
        var lastError: Error = APIError.invalidResponse

        for attempt in 1...maxRetries {
            do {
                return try await operation()
            } catch let error as APIError where error.isRetryable {
                lastError = error
            } catch let error as URLError where Self.isRetryableURLError(error) {
                lastError = error
            }
            // Non-retryable errors propagate out of the do/catch above.
            if attempt < maxRetries {
                let delay = UInt64(pow(2.0, Double(attempt - 1))) * 1_000_000_000
                try await Task.sleep(nanoseconds: delay)
            }
        }

        throw lastError
    }

    private static func isRetryableURLError(_ error: URLError) -> Bool {
        switch error.code {
        case .timedOut,
             .networkConnectionLost,
             .notConnectedToInternet,
             .cannotConnectToHost,
             .dnsLookupFailed:
            return true
        default:
            return false
        }
    }

    // MARK: - Fetch Latest

    func fetchLatestGlucose() async throws -> GlucoseReading {
        try await withRetry { try await performFetch() }
    }

    private func performFetch() async throws -> GlucoseReading {
        var request = URLRequest(url: try baseURL.appendingPathComponent("api/glucose/latest"))
        applyAuth(to: &request)
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard http.statusCode == 200 else {
            throw APIError.httpError(http.statusCode)
        }

        let decoder = JSONDecoder()
        let reading = try decoder.decode(GlucoseReading.self, from: data)

        guard reading.sgv > 0 && reading.sgv < 600 else {
            throw APIError.invalidData("Glucose value out of bounds: \(reading.sgv)")
        }
        guard reading.date > 0 else {
            throw APIError.invalidData("Invalid timestamp")
        }

        return reading
    }

    // MARK: - Fetch History

    func fetchGlucoseHistory(hours: Int = 3) async throws -> [GlucoseReading] {
        try await withRetry { try await performHistoryFetch(hours: hours) }
    }

    private func performHistoryFetch(hours: Int) async throws -> [GlucoseReading] {
        var components = URLComponents(url: try baseURL.appendingPathComponent("api/glucose/range"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "hours", value: "\(hours)")]

        guard let url = components.url else {
            throw APIError.invalidResponse
        }

        var request = URLRequest(url: url)
        applyAuth(to: &request)
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard http.statusCode == 200 else {
            throw APIError.httpError(http.statusCode)
        }

        let decoder = JSONDecoder()
        var readings = try decoder.decode([GlucoseReading].self, from: data)

        // Validate each reading
        readings = readings.filter { $0.sgv > 0 && $0.sgv < 600 && $0.date > 0 }

        // Sort newest first
        readings.sort { $0.date > $1.date }

        return readings
    }

    // MARK: - Fetch Treatments

    func fetchTreatments(hours: Int = 3) async throws -> [Treatment] {
        try await withRetry { try await performTreatmentsFetch(hours: hours) }
    }

    private func performTreatmentsFetch(hours: Int) async throws -> [Treatment] {
        var components = URLComponents(url: try baseURL.appendingPathComponent("api/treatments"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "hours", value: "\(hours)")]

        guard let url = components.url else {
            throw APIError.invalidResponse
        }

        var request = URLRequest(url: url)
        applyAuth(to: &request)
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard http.statusCode == 200 else {
            throw APIError.httpError(http.statusCode)
        }

        let decoder = JSONDecoder()
        var treatments = try decoder.decode([Treatment].self, from: data)

        // Sort by timestamp ascending (oldest first)
        treatments.sort { $0.timestamp < $1.timestamp }

        return treatments
    }

    // MARK: - Fetch Prediction

    func fetchPrediction(features: [Double], horizon: Int = 30) async throws -> PredictionResult {
        try await withRetry { try await performPredictionFetch(features: features, horizon: horizon) }
    }

    private func performPredictionFetch(features: [Double], horizon: Int) async throws -> PredictionResult {
        let url = try baseURL.appendingPathComponent("api/predict")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        applyAuth(to: &request)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let body: [String: Any] = [
            "features": features,
            "horizon": horizon
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard http.statusCode == 200 else {
            throw APIError.httpError(http.statusCode)
        }

        let decoder = JSONDecoder()
        return try decoder.decode(PredictionResult.self, from: data)
    }

    // MARK: - Auto Prediction (server builds feature vector)

    /// Fetch prediction using the server-side auto endpoint.
    /// The server fetches glucose, treatments, and profile from Nightscout,
    /// builds the full feature vector, and calls the ONNX prediction server.
    func fetchAutoPrediction(horizon: Int = 30) async throws -> PredictionResult {
        try await withRetry { try await performAutoPredictionFetch(horizon: horizon) }
    }

    private func performAutoPredictionFetch(horizon: Int) async throws -> PredictionResult {
        var components = URLComponents(url: try baseURL.appendingPathComponent("api/predict/auto"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "horizon", value: "\(horizon)")]

        guard let url = components.url else {
            throw APIError.invalidResponse
        }

        var request = URLRequest(url: url)
        applyAuth(to: &request)
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard http.statusCode == 200 else {
            throw APIError.httpError(http.statusCode)
        }

        let decoder = JSONDecoder()
        return try decoder.decode(PredictionResult.self, from: data)
    }

    // MARK: - Fetch Pump Status

    func fetchPumpStatus() async throws -> PumpStatus {
        try await withRetry { try await performPumpStatusFetch() }
    }

    private func performPumpStatusFetch() async throws -> PumpStatus {
        var request = URLRequest(url: try baseURL.appendingPathComponent("api/pump/status"))
        applyAuth(to: &request)
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard http.statusCode == 200 else {
            throw APIError.httpError(http.statusCode)
        }

        let decoder = JSONDecoder()
        return try decoder.decode(PumpStatus.self, from: data)
    }

    // MARK: - Fetch IOB/COB

    func fetchIOBCOB() async throws -> (iob: Double, cob: Double, iobDisplay: String, cobDisplay: String) {
        try await withRetry { try await performIOBCOBFetch() }
    }

    private func performIOBCOBFetch() async throws -> (iob: Double, cob: Double, iobDisplay: String, cobDisplay: String) {
        var request = URLRequest(url: try baseURL.appendingPathComponent("api/pump/iob"))
        applyAuth(to: &request)
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard http.statusCode == 200 else {
            throw APIError.httpError(http.statusCode)
        }

        let decoded = try JSONDecoder().decode(IOBCOBResponse.self, from: data)
        return (iob: decoded.iob, cob: decoded.cob, iobDisplay: decoded.iobDisplay, cobDisplay: decoded.cobDisplay)
    }

    // MARK: - Fetch Patient Profile

    func fetchProfile() async throws -> PatientProfile {
        try await withRetry { try await performProfileFetch() }
    }

    private func performProfileFetch() async throws -> PatientProfile {
        var request = URLRequest(url: try baseURL.appendingPathComponent("api/profile"))
        applyAuth(to: &request)
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard http.statusCode == 200 else {
            throw APIError.httpError(http.statusCode)
        }

        return try JSONDecoder().decode(PatientProfile.self, from: data)
    }

    // MARK: - Auth Management

    /// Whether any auth method is configured
    var isAuthenticated: Bool {
        !bearerToken.isEmpty || !apiKey.isEmpty
    }

    /// Whether the API key specifically is configured
    var isAPIKeyConfigured: Bool {
        !apiKey.isEmpty
    }

    /// Update Bearer JWT (from username/password login)
    func updateBearerToken(_ token: String) {
        bearerToken = token
        AuthManager.saveToKeychain(service: AppConfig.jwtKeychainService, value: token)
    }

    /// Clear all auth (logout)
    func clearAuth() {
        bearerToken = ""
        apiKey = ""
        AuthManager.deleteFromKeychain(service: AppConfig.jwtKeychainService)
        Self.deleteKeyFromKeychain()
    }

    private static func deleteKeyFromKeychain() {
        AuthManager.deleteFromKeychain(service: AppConfig.apiKeyKeychainService)
    }

    /// Test the current auth by hitting /api/glucose/latest
    func testConnection() async -> Bool {
        guard isAuthenticated else { return false }
        do {
            _ = try await fetchLatestGlucose()
            return true
        } catch {
            return false
        }
    }

    func updateAPIKey(_ newKey: String) {
        apiKey = newKey
        Self.saveKeyToKeychain(newKey)
    }

    private static func loadKeyFromKeychain() -> String? {
        AuthManager.loadFromKeychain(service: AppConfig.apiKeyKeychainService)
    }

    private static func saveKeyToKeychain(_ key: String) {
        AuthManager.saveToKeychain(service: AppConfig.apiKeyKeychainService, value: key)
    }
}

// MARK: - API Error

enum APIError: LocalizedError {
    case notConfigured
    case invalidResponse
    case httpError(Int)
    case invalidData(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "No server configured. Enter your ClearSugar server URL in setup."
        case .invalidResponse:
            return "Invalid response from server"
        case .httpError(let code):
            switch code {
            case 401, 403: return "Authentication failed. Sign in again in Settings."
            case 429: return "Too many requests. Retrying in a moment..."
            case 500...599: return "Server error. The ClearSugar backend may be down."
            default: return "Server error (HTTP \(code))"
            }
        case .invalidData(let detail):
            return "Invalid data received: \(detail)"
        }
    }

    var isRetryable: Bool {
        switch self {
        case .httpError(let code):
            return code == 429 || (500...599).contains(code)
        case .invalidResponse:
            return true
        case .notConfigured, .invalidData:
            return false
        }
    }
}

// MARK: - Pump Status

struct PumpStatus: Codable, Sendable {
    let currentBasalRate: Double?
    let boluses: BolusInfo?
    let carbs: CarbInfo?
    let lastPumpUpdate: String?
    let pumpStaleMinutes: Int?
    let pumpIsStale: Bool?

    struct BolusInfo: Codable, Sendable {
        let count: Int
        let totalUnits: Double
    }

    struct CarbInfo: Codable, Sendable {
        let count: Int
        let totalGrams: Double
    }
}

// MARK: - IOB/COB Response

struct IOBCOBResponse: Codable, Sendable {
    let iob: Double
    let cob: Double
    let iobDisplay: String
    let cobDisplay: String
}

// MARK: - Patient Profile (GET /api/profile)

struct PatientProfile: Codable, Sendable {
    let name: String
    let ageYears: Int?
    let cgm: String?
    let pump: String?
    let insulinNotes: String?
    let clinicalNotes: String?
}
