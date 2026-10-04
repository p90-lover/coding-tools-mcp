//! Standard MCP form string formats (no new validator dependency).
pub(super) fn valid(format: Option<&str>, text: &str) -> bool {
    match format {
        None => true,
        Some("uri") => {
            text.trim() == text
                && !text.chars().any(char::is_control)
                && url::Url::parse(text).is_ok()
        }
        Some("email") => email(text),
        Some("date") => date(text),
        Some("date-time") => date_time(text),
        _ => false,
    }
}
fn date(text: &str) -> bool {
    if text.len() != 10
        || !text.is_ascii()
        || text.as_bytes()[4] != b'-'
        || text.as_bytes()[7] != b'-'
    {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) = (
        text[..4].parse::<u32>(),
        text[5..7].parse::<u32>(),
        text[8..].parse::<u32>(),
    ) else {
        return false;
    };
    let days = match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    (1..=days).contains(&day)
        && text
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}
fn date_time(text: &str) -> bool {
    if text.len() < 20
        || !text.is_ascii()
        || !date(&text[..10])
        || !matches!(text.as_bytes()[10], b'T' | b't')
    {
        return false;
    }
    let tail = &text[11..];
    let clock = if tail.ends_with(['Z', 'z']) {
        &tail[..tail.len() - 1]
    } else {
        let Some(offset) = tail.rfind(['+', '-']) else {
            return false;
        };
        let zone = &tail[offset..];
        if zone.len() != 6
            || zone.as_bytes()[3] != b':'
            || !zone[1..3]
                .bytes()
                .chain(zone[4..].bytes())
                .all(|byte| byte.is_ascii_digit())
            || !zone[1..3].parse::<u32>().is_ok_and(|hour| hour <= 23)
            || !zone[4..].parse::<u32>().is_ok_and(|minute| minute <= 59)
        {
            return false;
        }
        &tail[..offset]
    };
    if clock.len() < 8 || clock.as_bytes()[2] != b':' || clock.as_bytes()[5] != b':' {
        return false;
    }
    if !clock[..8]
        .bytes()
        .enumerate()
        .all(|(index, byte)| matches!(index, 2 | 5) || byte.is_ascii_digit())
        || !clock[..2].parse::<u32>().is_ok_and(|hour| hour <= 23)
        || !clock[3..5].parse::<u32>().is_ok_and(|minute| minute <= 59)
        || !clock[6..8].parse::<u32>().is_ok_and(|second| second <= 60)
    {
        return false;
    }
    clock.len() == 8
        || (clock.len() > 9
            && clock.as_bytes()[8] == b'.'
            && clock[9..].bytes().all(|byte| byte.is_ascii_digit()))
}
fn email(text: &str) -> bool {
    let Some((local, domain)) = text.rsplit_once('@') else {
        return false;
    };
    if local.is_empty()
        || local.len() > 64
        || domain.is_empty()
        || domain.len() > 253
        || !text.is_ascii()
    {
        return false;
    }
    let quoted = local.starts_with('"') && local.ends_with('"') && local.len() >= 2;
    let local_valid = if quoted {
        let mut escaped = false;
        local[1..local.len() - 1].bytes().all(|byte| {
            if escaped {
                escaped = false;
                return (32..=126).contains(&byte);
            }
            if byte == b'\\' {
                escaped = true;
                return true;
            }
            (32..=126).contains(&byte) && byte != b'"'
        }) && !escaped
    } else {
        !local.starts_with('.')
            && !local.ends_with('.')
            && !local.contains("..")
            && local
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-/=?^_`{|}~.".contains(&byte))
    };
    if !local_valid {
        return false;
    }
    if domain.starts_with('[') && domain.ends_with(']') {
        return domain[1..domain.len() - 1]
            .strip_prefix("IPv6:")
            .unwrap_or(&domain[1..domain.len() - 1])
            .parse::<std::net::IpAddr>()
            .is_ok();
    }
    domain.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}
