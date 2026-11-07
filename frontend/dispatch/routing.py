import os
from ortools.constraint_solver import pywrapcp, routing_enums_pb2
from .maps import haversine


def solve(origin, jobs, technicians, factor=1.3, speed=40, capacity=5, seconds=2):
    if not technicians:
        return {'routes': [], 'unassigned': [{**j, 'reason': '기사 없음'} for j in jobs]}
    eligible, unassigned = [], []
    for job in jobs:
        # This demo treats every engineer as equally capable. A technician's
        # label is informational only; routing is optimized by distance/time.
        allowed = list(range(len(technicians)))
        if allowed:
            eligible.append((job, allowed))
        else:
            unassigned.append({**job, 'reason': '전문 파트가 맞는 기사 없음'})
    if not eligible:
        return {'routes': [{'technician': t, 'jobs': []} for t in technicians], 'unassigned': unassigned}
    points = [origin] + [job['coordinates'] for job, _ in eligible]
    matrix = [[round(haversine(a,b)*factor/(speed*1000/3600)) for b in points] for a in points]
    # Each vehicle starts at HQ and ends at a zero-cost virtual node after its last visit.
    real_nodes, vehicles = len(points), len(technicians)
    total_nodes = real_nodes + vehicles
    manager = pywrapcp.RoutingIndexManager(
        total_nodes,
        vehicles,
        [0] * vehicles,
        list(range(real_nodes, total_nodes)),
    )
    routing = pywrapcp.RoutingModel(manager)
    def transit(a, b):
        start, end = manager.IndexToNode(a), manager.IndexToNode(b)
        if start >= real_nodes or end >= real_nodes:
            return 0
        return matrix[start][end]
    callback = routing.RegisterTransitCallback(transit)
    routing.SetArcCostEvaluatorOfAllVehicles(callback)
    demand = routing.RegisterUnaryTransitCallback(lambda index: int(0 < manager.IndexToNode(index) < real_nodes))
    routing.AddDimensionWithVehicleCapacity(demand, 0, [capacity]*vehicles, True, 'Jobs')
    base = max(1, max(map(max, matrix)))*(len(jobs)+vehicles+1)+1
    penalties = {'high': base*(len(jobs)+1)**2, 'normal': base*(len(jobs)+1), 'low': base}
    for node, (job, allowed) in enumerate(eligible, 1):
        index = manager.NodeToIndex(node)
        for vehicle in range(vehicles):
            if vehicle not in allowed:
                routing.VehicleVar(index).RemoveValue(vehicle)
        routing.AddDisjunction([index], penalties[job['priority']])
    settings = pywrapcp.DefaultRoutingSearchParameters()
    settings.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    settings.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    settings.time_limit.seconds = seconds
    solution = routing.SolveWithParameters(settings)
    if not solution:
        return {'routes': [{'technician': t, 'jobs': []} for t in technicians], 'unassigned': unassigned + [{**j, 'reason': '시간 내 해를 찾지 못함'} for j, _ in eligible]}
    routes, assigned = [], set()
    for vehicle, tech in enumerate(technicians):
        index, ordered = routing.Start(vehicle), []
        while not routing.IsEnd(index):
            node = manager.IndexToNode(index)
            if 0 < node < real_nodes:
                job = eligible[node-1][0]
                ordered.append(job)
                assigned.add(job['id'])
            index = solution.Value(routing.NextVar(index))
        routes.append({'technician': tech, 'jobs': ordered})
    unassigned += [{**j, 'reason': '일일 5건 한도·긴급도 반영 후 미배정'} for j, _ in eligible if j['id'] not in assigned]
    return {'routes': routes, 'unassigned': unassigned}
