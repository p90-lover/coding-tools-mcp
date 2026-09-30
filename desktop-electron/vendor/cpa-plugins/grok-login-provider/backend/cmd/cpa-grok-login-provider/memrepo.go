package main

import (
	"context"
	"sort"
	"sync"
	"time"

	egressdomain "github.com/chenyme/grok2api/backend/internal/domain/egress"
	inferencedomain "github.com/chenyme/grok2api/backend/internal/domain/inference"
	"github.com/chenyme/grok2api/backend/internal/repository"
)

// memoryEgressRepository replaces grok2api's relational egress tables. CPA owns proxy policy,
// so the plugin only needs one node per (scope, proxy URL) plus a direct fallback when the
// resolved proxy is empty.
type memoryEgressRepository struct {
	mu     sync.Mutex
	nextID uint64
	nodes  map[uint64]egressdomain.Node
	byKey  map[string]uint64
}

func newMemoryEgressRepository() *memoryEgressRepository {
	return &memoryEgressRepository{nodes: make(map[uint64]egressdomain.Node), byKey: make(map[string]uint64)}
}

// nodeFor returns the node that routes scope through proxyURL, creating it on first use.
// encryptedProxy is the cipher output for proxyURL; the manager decrypts it per request.
func (r *memoryEgressRepository) nodeFor(scope egressdomain.Scope, proxyURL, encryptedProxy string) uint64 {
	key := string(scope) + "\x00" + proxyURL
	r.mu.Lock()
	defer r.mu.Unlock()
	if id, ok := r.byKey[key]; ok {
		return id
	}
	r.nextID++
	now := time.Now().UTC()
	r.nodes[r.nextID] = egressdomain.Node{
		ID: r.nextID, Name: "cpa-" + string(scope), Scope: scope, Enabled: true, Health: 1,
		EncryptedProxyURL: encryptedProxy, CreatedAt: now, UpdatedAt: now,
	}
	r.byKey[key] = r.nextID
	return r.nextID
}

func (r *memoryEgressRepository) ListEgressNodes(_ context.Context, scope egressdomain.Scope, _ repository.SortQuery) ([]egressdomain.Node, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	values := make([]egressdomain.Node, 0, len(r.nodes))
	for _, node := range r.nodes {
		if node.Scope == scope {
			values = append(values, node)
		}
	}
	sort.Slice(values, func(i, j int) bool { return values[i].ID < values[j].ID })
	return values, nil
}

func (r *memoryEgressRepository) GetEgressNode(_ context.Context, id uint64) (egressdomain.Node, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	node, ok := r.nodes[id]
	if !ok {
		return egressdomain.Node{}, repository.ErrNotFound
	}
	return node, nil
}

func (r *memoryEgressRepository) CreateEgressNode(_ context.Context, value egressdomain.Node) (egressdomain.Node, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nextID++
	value.ID = r.nextID
	r.nodes[value.ID] = value
	return value, nil
}

func (r *memoryEgressRepository) UpdateEgressNode(_ context.Context, value egressdomain.Node) (egressdomain.Node, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.nodes[value.ID]; !ok {
		return egressdomain.Node{}, repository.ErrNotFound
	}
	r.nodes[value.ID] = value
	return value, nil
}

func (r *memoryEgressRepository) DeleteEgressNode(_ context.Context, id uint64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.nodes, id)
	for key, nodeID := range r.byKey {
		if nodeID == id {
			delete(r.byKey, key)
		}
	}
	return nil
}

// GetEgressOperationsConfig makes every scope fall back to a direct connection. The manager
// reads it only when no node is bound, i.e. when neither CPA nor the auth file sets a proxy.
func (r *memoryEgressRepository) GetEgressOperationsConfig(context.Context) (egressdomain.OperationsConfig, error) {
	cfg := egressdomain.DefaultOperationsConfig()
	cfg.AutoAssignEnabled = false
	cfg.AutoBalanceEnabled = false
	for scope := range cfg.Fallbacks {
		cfg.Fallbacks[scope] = egressdomain.FallbackConfig{Mode: egressdomain.FallbackModeDirect}
	}
	return cfg, nil
}

// memoryResponseRepository keeps Grok Web conversation cursors for previous_response_id
// follow-ups. State is process-local: CPA restarts start new upstream conversations.
type memoryResponseRepository struct {
	mu         sync.Mutex
	ownerships map[string]inferencedomain.ResponseOwnership
	webStates  map[string]inferencedomain.WebResponseState
}

func newMemoryResponseRepository() *memoryResponseRepository {
	return &memoryResponseRepository{
		ownerships: make(map[string]inferencedomain.ResponseOwnership),
		webStates:  make(map[string]inferencedomain.WebResponseState),
	}
}

func (r *memoryResponseRepository) Save(_ context.Context, value inferencedomain.ResponseOwnership) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ownerships[value.ResponseID] = value
	return nil
}

func (r *memoryResponseRepository) Get(_ context.Context, responseID string, _ uint64, now time.Time) (inferencedomain.ResponseOwnership, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	value, ok := r.ownerships[responseID]
	if !ok || (!value.ExpiresAt.IsZero() && now.After(value.ExpiresAt)) {
		return inferencedomain.ResponseOwnership{}, repository.ErrNotFound
	}
	return value, nil
}

func (r *memoryResponseRepository) Delete(_ context.Context, responseID string, _ uint64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.ownerships, responseID)
	return nil
}

func (r *memoryResponseRepository) DeleteExpired(_ context.Context, now time.Time, _, _ int) (repository.ResponseCleanupResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var result repository.ResponseCleanupResult
	for id, value := range r.ownerships {
		if !value.ExpiresAt.IsZero() && now.After(value.ExpiresAt) {
			delete(r.ownerships, id)
			result.OwnershipDeleted++
		}
	}
	for id, value := range r.webStates {
		if !value.ExpiresAt.IsZero() && now.After(value.ExpiresAt) {
			delete(r.webStates, id)
			result.WebStateDeleted++
		}
	}
	return result, nil
}

func (r *memoryResponseRepository) SaveWebState(_ context.Context, value inferencedomain.WebResponseState) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.webStates[value.ResponseID] = value
	return nil
}

func (r *memoryResponseRepository) GetWebState(_ context.Context, responseID string, now time.Time) (inferencedomain.WebResponseState, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	value, ok := r.webStates[responseID]
	if !ok || (!value.ExpiresAt.IsZero() && now.After(value.ExpiresAt)) {
		return inferencedomain.WebResponseState{}, repository.ErrNotFound
	}
	return value, nil
}

func (r *memoryResponseRepository) DeleteWebState(_ context.Context, responseID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.webStates, responseID)
	return nil
}

var (
	_ repository.EgressRepository   = (*memoryEgressRepository)(nil)
	_ repository.ResponseRepository = (*memoryResponseRepository)(nil)
)
