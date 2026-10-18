from core.base_platform import RegisterConfig
from core.registry import get_platform_capabilities
from platforms.anything.plugin import AnythingPlatform


def test_anything_declares_its_real_registration_path():
    capabilities = get_platform_capabilities("anything")
    assert capabilities["supported_identity_modes"] == ["mailbox"]
    assert capabilities["supported_executors"] == ["protocol"]
    assert capabilities["supported_oauth_providers"] == []
    platform = AnythingPlatform(config=RegisterConfig(executor_type="protocol"))
    assert platform.build_protocol_mailbox_adapter() is not None
