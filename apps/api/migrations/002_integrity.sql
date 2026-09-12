CREATE UNIQUE INDEX roads_tenant_code ON roads(tenant_id,(data->>'code'));
