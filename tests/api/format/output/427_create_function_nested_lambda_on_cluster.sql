CREATE OR REPLACE FUNCTION normalise_tags ON CLUSTER analytics_cluster AS
    tags -> arrayDistinct(
        arrayFilter(t -> t != '', arrayMap(t -> lower(trimBoth(t)), tags))
    )