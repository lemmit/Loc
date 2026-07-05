// Auto-generated.
using System;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CatalogApi.Serialization;

/// <summary>Serializes a <see cref="DateTime"/> as canonical ISO-8601 UTC:
/// trailing zero fractional seconds are trimmed (and the decimal point dropped
/// when the fraction is entirely zero), matching the node / Python / Java
/// backends.  Reads keep accepting the standard ISO-8601 inputs the default
/// reader accepts.</summary>
public sealed class CanonicalInstantJsonConverter : JsonConverter<DateTime>
{
    public override DateTime Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.GetDateTime();

    public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions options)
        => writer.WriteStringValue(CanonicalInstant.Format(value));
}

/// <summary>The <see cref="DateTimeOffset"/> sibling of
/// <see cref="CanonicalInstantJsonConverter"/> — normalizes to UTC before
/// applying the same canonical trim.</summary>
public sealed class CanonicalInstantOffsetJsonConverter : JsonConverter<DateTimeOffset>
{
    public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.GetDateTimeOffset();

    public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options)
        => writer.WriteStringValue(CanonicalInstant.Format(value.UtcDateTime));
}

internal static class CanonicalInstant
{
    /// <summary>Canonical ISO-8601 UTC string for <paramref name="value"/>.
    /// "o" on a UTC DateTime is <c>yyyy-MM-ddTHH:mm:ss.fffffffZ</c> (a fixed
    /// 7-digit fraction plus the trailing 'Z'); trim the fraction's trailing
    /// zeros and drop the decimal point entirely when the whole fraction is
    /// zero.  "12:00:00" -> "...00Z"; ".1230000" -> "....123Z".</summary>
    public static string Format(DateTime value)
    {
        string s = value.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture);
        int dot = s.IndexOf('.');
        if (dot < 0)
        {
            return s;
        }
        int end = s.Length - 2; // last fractional digit, before the trailing 'Z'
        while (end > dot && s[end] == '0')
        {
            end--;
        }
        return end == dot
            ? string.Concat(s.AsSpan(0, dot), "Z")
            : string.Concat(s.AsSpan(0, end + 1), "Z");
    }
}
