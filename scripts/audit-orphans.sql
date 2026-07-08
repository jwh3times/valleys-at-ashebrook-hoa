-- Run before applying the FK migration remotely:
-- wrangler d1 execute ashebrook-hoa --remote --file scripts/audit-orphans.sql

SELECT 'owners_missing_property' AS check_name, count(*) AS orphan_count
FROM owners o
LEFT JOIN properties p ON p.id = o.property_id
WHERE p.id IS NULL;

SELECT 'user_property_links_missing_user' AS check_name, count(*) AS orphan_count
FROM user_property_links upl
LEFT JOIN users u ON u.id = upl.user_id
WHERE u.id IS NULL;

SELECT 'user_property_links_missing_property' AS check_name, count(*) AS orphan_count
FROM user_property_links upl
LEFT JOIN properties p ON p.id = upl.property_id
WHERE p.id IS NULL;

SELECT 'property_verifications_missing_user' AS check_name, count(*) AS orphan_count
FROM property_verifications pv
LEFT JOIN users u ON u.id = pv.user_id
WHERE u.id IS NULL;

SELECT 'property_verifications_missing_property' AS check_name, count(*) AS orphan_count
FROM property_verifications pv
LEFT JOIN properties p ON p.id = pv.property_id
WHERE p.id IS NULL;

SELECT 'manual_approval_queue_missing_user' AS check_name, count(*) AS orphan_count
FROM manual_approval_queue maq
LEFT JOIN users u ON u.id = maq.user_id
WHERE u.id IS NULL;
